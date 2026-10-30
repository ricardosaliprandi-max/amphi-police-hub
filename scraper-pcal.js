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
    });

    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação de rede para economizar RAM no Render, mas capturando o POST da API
    let endpointRealDaApi = null;
    let payloadCapturado = null;

    await page.setRequestInterception(true);
    page.on('request', interceptedRequest => {
      const url = interceptedRequest.url();
      // Captura qualquer POST de API gerado pelos scripts da Vsoft ao submeter o form
      if (url.includes('/api/') && interceptedRequest.method() === 'POST') {
        endpointRealDaApi = url;
        payloadCapturado = interceptedRequest.postData();
      }
      interceptedRequest.continue();
    });

    console.log(`[PCAL] Acessando portal oficial para: ${dados.candidateName || dados.nome}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da PCAL: ${err.message}`);
    });

    await page.waitForSelector('#form', { timeout: 20000 }).catch(() => {
      throw new Error('O formulário principal (#form) não foi renderizado no portal da PCAL.');
    });

    // 1. Normalização dos dados de entrada
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

    // 2. Preenchimento simulando eventos humanos reais para ativar o validador do site
    await page.evaluate((payload) => {
      const setInputValue = (selector, value) => {
        const el = document.querySelector(selector);
        if (el && value) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      };

      setInputValue('#rg', payload.rg);
      setInputValue('#orgaoExpedidor', payload.orgaoExpedidor);
      setInputValue('#nome', payload.candidateName);
      setInputValue('#dataNascimento', payload.dataFormatada);
      setInputValue('#cpf', payload.candidateCpf);
      setInputValue('#mae', payload.motherName);
      setInputValue('#pai', payload.fatherName);
    }, {
      candidateName: rawName.toUpperCase().trim(),
      candidateCpf: cpfLimpo,
      rg: rgLimpo,
      orgaoExpedidor: rawOrgao.toUpperCase().trim(),
      dataFormatada,
      motherName: rawMother.toUpperCase().trim(),
      fatherName: rawFather.toUpperCase().trim()
    });

    await new Promise(r => setTimeout(r, 1000));

    // 3. Dispara o clique no botão oficial #btEmitir para forçar o envio da requisição
    console.log('[PCAL] Acionando botão de emissão (#btEmitir)...');
    
    const clickRealizado = await page.evaluate(() => {
      const btn = document.querySelector('#btEmitir');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clickRealizado) {
      throw new Error('Botão de emissão (#btEmitir) não foi encontrado no DOM da PCAL.');
    }

    // 4. Aguarda a interceptação de rede capturar a URL e o payload gerados pelo site
    let tentativas = 0;
    while (!endpointRealDaApi && tentativas < 20) {
      await new Promise(r => setTimeout(r, 300));
      tentativas++;
    }

    if (!endpointRealDaApi) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'FALHA NA CAPTURA DA API',
        mensagem: 'O portal da PCAL não disparou a requisição POST de API após o acionamento do botão. Verifique restrições de validação do formulário.'
      };
    }

    console.log(`[PCAL] Rota real da API interceptada com sucesso: ${endpointRealDaApi}`);

    // Se chegou aqui, capturamos o endpoint exato e a estrutura que o site utiliza.
    // Vamos aguardar a resposta da requisição interceptada ou processar o resultado.
    await new Promise(r => setTimeout(r, 3000));

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'ROTA DA API MAPEADA',
      mensagem: `Endpoint real validado: ${endpointRealDaApi}`,
      rawSnippet: payloadCapturado ? payloadCapturado.slice(0, 300) : 'Payload vazio'
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
