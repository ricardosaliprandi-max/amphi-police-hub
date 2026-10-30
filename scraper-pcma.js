import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMA(dados) {
  const URL_ALVO = 'https://antecedentes.ssp.ma.gov.br/';
  
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
    
    // Camuflagem rigorosa anti-bot
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    });

    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação inteligente: Permite scripts (vital para a SPA Vite), mas bloqueia imagens/fontes/mídia
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Listener de rede para capturar a rota da API de antecedentes do Maranhão
    let endpointRealDaApi = null;
    let respostaApiJson = null;

    page.on('response', async res => {
      const url = res.url();
      if (url.includes('/api/') || url.includes('/consulta') || url.includes('/emitir')) {
        try {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            endpointRealDaApi = url;
            respostaApiJson = await res.json().catch(() => null);
          }
        } catch (e) {}
      }
    });

    console.log(`[PCMA] Acessando portal do Maranhão para: ${dados.candidateName || dados.nome}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'networkidle0', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da PCMA: ${err.message}`);
    });

    // Como é uma SPA, aguarda o elemento raiz #app hidratar e renderizar os inputs do formulário
    console.log('[PCMA] Aguardando renderização da SPA (Vite)...');
    await page.waitForFunction(() => document.querySelectorAll('input').length > 0, { timeout: 20000 }).catch(() => {
      throw new Error('A SPA da PCMA demorou muito para renderizar os campos de entrada.');
    });

    // 1. Normalização dos dados de entrada
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawName = dados.candidateName || dados.nome || '';
    const rawBirth = dados.candidateBirthDate || dados.dataNascimento || '';
    const rawMother = dados.motherName || dados.nomeMae || '';
    const rawRg = dados.rg || dados.numero || '';

    const cpfLimpo = String(rawCpf).replace(/\D/g, '');
    
    let dataFormatada = rawBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }

    // 2. Preenchimento inteligente dos inputs da SPA simulando eventos nativos do Vue/React
    await page.evaluate((payload) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      
      // Função auxiliar para injetar valor e disparar eventos de framework reativo
      const preencherInputPorPlaceholderOuId = (termo, valor) => {
        if (!valor) return;
        for (const input of inputs) {
          const ph = (input.placeholder || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const name = (input.name || '').toLowerCase();
          
          if (ph.includes(termo) || id.includes(termo) || name.includes(termo)) {
            input.value = valor;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            break;
          }
        }
      };

      preencherInputPorPlaceholderOuId('cpf', payload.cpf);
      preencherInputPorPlaceholderOuId('nome', payload.nome);
      preencherInputPorPlaceholderOuId('nascimento', payload.dataNascimento);
      preencherInputPorPlaceholderOuId('mãe', payload.nomeMae);
      preencherInputPorPlaceholderOuId('rg', payload.rg);
    }, {
      cpf: cpfLimpo,
      nome: rawName.toUpperCase().trim(),
      dataNascimento: dataFormatada,
      nomeMae: rawMother.toUpperCase().trim(),
      rg: rawRg
    });

    await new Promise(r => setTimeout(r, 1500));

    // 3. Localiza e aciona o botão de submissão (Pesquisar / Emitir)
    console.log('[PCMA] Acionando botão de consulta na SPA...');
    await page.evaluate(() => {
      const botoes = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
      for (const btn of botoes) {
        const texto = (btn.innerText || btn.value || '').toLowerCase();
        if (texto.includes('pesquisar') || texto.includes('emitir') || texto.includes('consultar') || texto.includes('gerar')) {
          btn.click();
          return;
        }
      }
      // Fallback: clica no primeiro botão primário encontrado
      if (botoes.length > 0) botoes[0].click();
    });

    // Aguarda a resposta da API ser interceptada pelo listener
    let tentativas = 0;
    while (!respostaApiJson && tentativas < 20) {
      await new Promise(r => setTimeout(r, 400));
      tentativas++;
    }

    if (!respostaApiJson) {
      // Se não interceptou JSON via response, captura o texto visível na tela após a submissão
      const textoTela = await page.evaluate(() => document.body.innerText || '');
      
      if (textoTela.toUpperCase().includes('NADA CONSTA') || textoTela.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
        return {
          sucesso: true,
          hasRecords: false,
          statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
          mensagem: 'Nada Consta nos registros da PCMA (capturado via DOM da SPA).'
        };
      }

      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'RESPOSTA DA SPA INDEFINIDA',
        mensagem: 'A automação preencheu a SPA do Maranhão, mas a API de retorno não foi interceptada.',
        rawSnippet: textoTela.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    const temRegistros = respostaApiJson.hasRecords || respostaApiJson.possuiRegistros || false;

    return {
      sucesso: true,
      hasRecords: temRegistros,
      riskLevel: temRegistros ? 'HIGH' : 'LOW',
      statusTexto: temRegistros ? 'REGISTRO LOCALIZADO' : 'CERTIDÃO NEGATIVA EMITIDA',
      mensagem: respostaApiJson.mensagem || 'Consulta processada com sucesso pela PCMA.',
      rawSnippet: JSON.stringify(respostaApiJson).slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCMA] Erro crítico na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCMA',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCMA] Navegador encerrado com sucesso.`);
    }
  }
}
