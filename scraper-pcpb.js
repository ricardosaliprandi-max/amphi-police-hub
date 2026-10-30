import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPB(dados) {
  const URL_ALVO = 'https://antecedentes.pc.pb.gov.br/EmitirAAC';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Essencial para o limite de 512MB de RAM no Render
      '--disable-gpu',
      '--disable-infobars',
      '--window-size=1280,800',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Camuflagem anti-bot
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
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

    console.log(`[PCPB] Acessando portal da Paraíba para colher tokens: ${dados.candidateName || dados.nome}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da PCPB: ${err.message}`);
    });

    // Aguarda o formulário principal carregar
    await page.waitForSelector('#form', { timeout: 20000 }).catch(() => {
      throw new Error('O formulário principal (#form) não foi renderizado no portal da PCPB.');
    });

    // 1. Extração dos Tokens de Segurança do DOM e Cookies de Sessão
    const sessionData = await page.evaluate(() => {
      const csrfEl = document.querySelector('input[name="__RequestVerificationToken"]');
      const internalEl = document.querySelector('meta[name="internal-key"]');
      
      return {
        requestVerificationToken: csrfEl ? csrfEl.value : null,
        internalKey: internalEl ? internalEl.getAttribute('content') : null
      };
    });

    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    if (!sessionData.requestVerificationToken || !sessionData.internalKey) {
      throw new Error('Não foi possível extrair os tokens de segurança do portal PCPB.');
    }

    console.log('[PCPB] Tokens de segurança e cookies extraídos com sucesso.');

    // 2. Normalização dos dados de entrada
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

    // Endpoint oficial capturado pela auditoria de rede
    const apiUrlReal = 'https://app.sesds.pb.gov.br/Vsoft.iDSps.API/api/atestadoantecedentes/gerar';

    const payloadApi = {
      Cpf: cpfLimpo,
      Rg: rgLimpo,
      OrgaoExpedidor: rawOrgao.toUpperCase().trim(),
      Nome: rawName.toUpperCase().trim(),
      DataNascimento: dataFormatada,
      NomeMae: rawMother.toUpperCase().trim(),
      NomePai: rawFather.toUpperCase().trim()
    };

    // 3. Execução da chamada HTTP protegida diretamente pelo Node.js com proteção contra Cold-Start
    let respostaApi = null;
    let tentativasRestantes = 3;

    while (tentativasRestantes > 0) {
      try {
        const fetchRes = await fetch(apiUrlReal, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'RequestVerificationToken': sessionData.requestVerificationToken,
            'X-Internal-Key': sessionData.internalKey,
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': URL_ALVO
          },
          body: JSON.stringify(payloadApi)
        });

        const responseText = await fetchRes.text();

        // Se retornar HTML, indica possível cold-start / instabilidade do servidor da Paraíba
        if (responseText.trim().startsWith('<') || responseText.includes('<!DOCTYPE html>') || responseText.includes('Service Unavailable')) {
          tentativasRestantes--;
          if (tentativasRestantes > 0) {
            console.warn(`[PCPB] Servidor retornou HTML (Cold-Start). Tentando novamente em 3s... (${tentativasRestantes} tentativas restantes)`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          return {
            sucesso: false,
            hasRecords: false,
            statusTexto: 'SERVIÇO PCPB INSTÁVEL / COLD-START',
            mensagem: 'O servidor da Paraíba retornou uma página HTML genérica em vez de dados.',
            rawSnippet: responseText.slice(0, 200)
          };
        }

        let jsonParse;
        try {
          jsonParse = JSON.parse(responseText);
        } catch (e) {
          jsonParse = { rawText: responseText };
        }

        respostaApi = {
          status: fetchRes.status,
          ok: fetchRes.ok,
          data: jsonParse
        };
        break;

      } catch (netErr) {
        tentativasRestantes--;
        if (tentativasRestantes === 0) {
          throw new Error(`Erro de rede ao comunicar com a API da PCPB: ${netErr.message}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!respostaApi || !respostaApi.ok) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'FALHA NA REQUISIÇÃO API PCPB',
        mensagem: `A API da PCPB retornou status ${respostaApi?.status || 500}: ${JSON.stringify(respostaApi?.data || 'Erro desconhecido')}`
      };
    }

    const apiResult = respostaApi.data || {};
    const temRegistros = apiResult.hasRecords || apiResult.possuiRegistros || false;
    const mensagemRetorno = apiResult.mensagem || apiResult.message || 'Consulta processada com sucesso pela PCPB.';

    return {
      sucesso: true,
      hasRecords: temRegistros,
      riskLevel: temRegistros ? 'HIGH' : 'LOW',
      statusTexto: temRegistros ? 'REGISTRO LOCALIZADO' : 'CERTIDÃO NEGATIVA EMITIDA',
      mensagem: mensagemRetorno,
      rawSnippet: JSON.stringify(apiResult).slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCPB] Erro crítico na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCPB',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCPB] Navegador encerrado com sucesso.`);
    }
  }
}
