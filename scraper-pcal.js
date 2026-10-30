import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCAL(dados) {
  const URL_ALVO = 'https://idseg.institutodeidentificacao.al.gov.br/Vsoft.iDSPS.Agendamento/EmitirAAC';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Essencial para gerir o limite rígido de 512MB de RAM no Render
      '--disable-gpu',
      '--disable-infobars',
      '--window-size=1280,800',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Camuflagem rigorosa anti-bot / WAF
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    });

    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação defensiva de recursos estáticos para economizar RAM no Render
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCAL] Acessando portal de Alagoas para: ${dados.candidateName || dados.nome}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da PCAL: ${err.message}`);
    });

    // Aguarda o formulário principal carregar
    await page.waitForSelector('#form', { timeout: 20000 }).catch(() => {
      throw new Error('O formulário principal (#form) não foi renderizado no portal da PCAL.');
    });

    // 1. Extração dos Tokens de Segurança do DOM (Anti-CSRF e Internal Key)
    const tokens = await page.evaluate(() => {
      const csrfEl = document.querySelector('input[name="__RequestVerificationToken"]');
      const internalEl = document.querySelector('meta[name="internal-key"]');
      
      return {
        requestVerificationToken: csrfEl ? csrfEl.value : null,
        internalKey: internalEl ? internalEl.getAttribute('content') : null
      };
    });

    if (!tokens.requestVerificationToken || !tokens.internalKey) {
      throw new Error('Não foi possível extrair os tokens de segurança (__RequestVerificationToken ou internal-key) do portal PCAL.');
    }

    console.log('[PCAL] Tokens de segurança extraídos com sucesso.');

    // 2. Normalização de dados recebidos do payload canônico/Zod
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawRg = dados.rg || dados.numero || '';
    const rawName = dados.candidateName || dados.nome || '';
    const rawBirth = dados.candidateBirthDate || dados.dataNascimento || '';
    const rawMother = dados.motherName || dados.nomeMae || '';
    const rawFather = dados.fatherName || dados.nomePai || '';
    const rawOrgao = dados.orgaoExpedidor || 'SSP';

    const cpfLimpo = String(rawCpf).replace(/\D/g, '');
    const rgLimpo = String(rawRg).replace(/\D/g, '');
    
    let dataFormatada = rawBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }

    // 3. Auditoria e interceptação de rede para capturar o endpoint POST real da API da Vsoft
    let endpointRealDaApi = null;
    page.on('request', interceptedRequest => {
      const url = interceptedRequest.url();
      if (url.includes('/api/') && interceptedRequest.method() === 'POST') {
        endpointRealDaApi = url;
      }
      interceptedRequest.continue();
    });

    // Preenchimento dos campos reais mapeados no HTML
    await page.evaluate((payload) => {
      if (document.querySelector('#rg')) document.querySelector('#rg').value = payload.rg || '';
      if (document.querySelector('#orgaoExpedidor')) document.querySelector('#orgaoExpedidor').value = payload.orgaoExpedidor || 'SSP';
      if (document.querySelector('#nome')) document.querySelector('#nome').value = payload.candidateName || '';
      if (document.querySelector('#dataNascimento')) document.querySelector('#dataNascimento').value = payload.dataFormatada || '';
      if (document.querySelector('#cpf')) document.querySelector('#cpf').value = payload.candidateCpf || '';
      if (document.querySelector('#mae')) document.querySelector('#mae').value = payload.motherName || '';
      if (document.querySelector('#pai')) document.querySelector('#pai').value = payload.fatherName || '';
    }, {
      candidateName: rawName.toUpperCase().trim(),
      candidateCpf: cpfLimpo,
      rg: rgLimpo,
      orgaoExpedidor: rawOrgao.toUpperCase().trim(),
      dataFormatada,
      motherName: rawMother.toUpperCase().trim(),
      fatherName: rawFather.toUpperCase().trim()
    });

    // Dispara o clique no botão de emissão (#btEmitir) para o portal iniciar a requisição AJAX
    console.log('[PCAL] Disparando botão de emissão para acionar a API...');
    await page.click('#btEmitir').catch(async () => {
      await page.evaluate(() => document.getElementById('btEmitir').click());
    });

    // Aguarda o ciclo de requisição assíncrona ser capturado pelo listener de rede
    let tentativas = 0;
    while (!endpointRealDaApi && tentativas < 15) {
      await new Promise(r => setTimeout(r, 400));
      tentativas++;
    }

    if (!endpointRealDaApi) {
      throw new Error('O scraper não conseguiu interceptar a URL de POST da API da PCAL durante o disparo do formulário.');
    }

    console.log(`[PCAL] Endpoint real descoberto via rede: ${endpointRealDaApi}`);

    // 4. Execução da chamada direta na API com proteção defensiva contra Cold-Start (retorno de HTML)
    const resultadoBusca = await page.evaluate(async (payload, apiTokens, apiUrl) => {
      const bodyData = {
        Cpf: payload.cpfLimpo,
        Rg: payload.rgLimpo,
        OrgaoExpedidor: payload.orgaoExpedidor,
        Nome: payload.candidateName,
        DataNascimento: payload.dataFormatada,
        NomeMae: payload.motherName,
        NomePai: payload.fatherName
      };

      let tentativasRestantes = 3;
      while (tentativasRestantes > 0) {
        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'RequestVerificationToken': apiTokens.requestVerificationToken,
              'X-Internal-Key': apiTokens.internalKey
            },
            body: JSON.stringify(bodyData)
          });

          const textResponse = await response.text();

          // Trata páginas HTML de erro ou Cold-Start retornadas pelo servidor de AL
          if (textResponse.trim().startsWith('<') || textResponse.includes('<!DOCTYPE html>') || textResponse.includes('Service Unavailable')) {
            tentativasRestantes--;
            if (tentativasRestantes > 0) {
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
            return {
              status: response.status,
              ok: false,
              error: 'Servidor retornou HTML (Possível Cold-Start ou instabilidade em Alagoas).',
              rawHtmlSnippet: textResponse.slice(0, 200)
            };
          }

          let jsonResponse;
          try {
            jsonResponse = JSON.parse(textResponse);
          } catch (e) {
            jsonResponse = { rawText: textResponse };
          }

          return {
            status: response.status,
            ok: response.ok,
            data: jsonResponse
          };
        } catch (err) {
          tentativasRestantes--;
          if (tentativasRestantes === 0) {
            return { status: 500, ok: false, error: err.message };
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }, {
      candidateName: rawName.toUpperCase().trim(),
      cpfLimpo,
      rgLimpo,
      orgaoExpedidor: rawOrgao.toUpperCase().trim(),
      dataFormatada,
      motherName: rawMother.toUpperCase().trim(),
      fatherName: rawFather.toUpperCase().trim()
    }, tokens, endpointRealDaApi);

    if (!resultadoBusca.ok) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'SERVIÇO PCAL INSTÁVEL / COLD-START',
        mensagem: resultadoBusca.error || `A API da PCAL retornou status ${resultadoBusca.status}.`,
        rawSnippet: resultadoBusca.rawHtmlSnippet || null
      };
    }

    const apiResult = resultadoBusca.data || {};
    const temRegistros = apiResult.hasRecords || apiResult.possuiRegistros || false;
    const mensagemRetorno = apiResult.mensagem || apiResult.message || 'Consulta processada com sucesso pela PCAL.';

    return {
      sucesso: true,
      hasRecords: temRegistros,
      riskLevel: temRegistros ? 'HIGH' : 'LOW',
      statusTexto: temRegistros ? 'REGISTRO LOCALIZADO' : 'CERTIDÃO NEGATIVA EMITIDA',
      mensagem: mensagemRetorno,
      rawSnippet: JSON.stringify(apiResult).slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCAL] Erro crítico na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCAL',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCAL] Navegador encerrado com sucesso.`);
    }
  }
}
