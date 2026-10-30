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
      '--single-process', // Essencial para gerir o limite estrito de 512MB de RAM no Render
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

    // Interceptação rigorosa de recursos para economizar RAM no Render
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

    // 3. Execução da chamada HTTP assíncrona (fetch) diretamente no contexto do navegador
    const resultadoBusca = await page.evaluate(async (payload, apiTokens) => {
      const bodyData = {
        Cpf: payload.cpfLimpo,
        Rg: payload.rgLimpo,
        OrgaoExpedidor: (payload.orgaoExpedidor || 'SSP').toUpperCase(),
        Nome: (payload.candidateName || '').toUpperCase().trim(),
        DataNascimento: payload.dataFormatada,
        NomeMae: (payload.motherName || '').toUpperCase().trim(),
        NomePai: (payload.fatherName || '').toUpperCase().trim()
      };

      try {
        const response = await fetch('https://idseg.institutodeidentificacao.al.gov.br/Vsoft.iDSps.API/api/antecedentes/emitir', {
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
        return {
          status: 500,
          ok: false,
          error: err.message
        };
      }
    }, {
      candidateName: rawName,
      cpfLimpo,
      rgLimpo,
      orgaoExpedidor: rawOrgao,
      dataFormatada,
      motherName: rawMother,
      fatherName: rawFather
    }, tokens);

    if (!resultadoBusca.ok) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'FALHA NA REQUISIÇÃO API PCAL',
        mensagem: `A API da PCAL retornou status ${resultadoBusca.status}: ${JSON.stringify(resultadoBusca.data || resultadoBusca.error)}`
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
