import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMS(dados) {
  const URL_ALVO = 'https://antecedentes.sejusp.ms.gov.br/pages/MasterPages/IUPrincipal.aspx';
  
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

    // Interceptação defensiva de recursos estáticos para economizar RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Listener para capturar eventuais respostas em JSON da API de antecedentes do MS
    let respostaApiJson = null;
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('Atestado') || url.includes('api') || url.includes('Emitir') || url.includes('Consultar')) {
        try {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            respostaApiJson = await res.json().catch(() => null);
          }
        } catch (e) {}
      }
    });

    console.log(`[PCMS] Acessando portal do Mato Grosso do Sul para: ${dados.candidateName || dados.nome}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'networkidle0', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da PCMS: ${err.message}`);
    });

    // Clica no menu "Solicitar" na página principal para carregar o formulário dentro do iframe
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const sol = links.find(l => l.innerText.toLowerCase().includes('solicitar'));
      if (sol) sol.click();
    });

    // Aguarda o frame interno carregar a página IUAtestado.aspx
    console.log('[PCMS] Aguardando carregamento do iframe de atestado...');
    let frameAtestado = null;
    let tentativas = 0;
    while (!frameAtestado && tentativas < 20) {
      const frames = page.frames();
      frameAtestado = frames.find(f => f.url().includes('IUAtestado.aspx'));
      if (!frameAtestado) {
        await new Promise(r => setTimeout(r, 500));
        tentativas++;
      }
    }

    if (!frameAtestado) {
      throw new Error('O iframe de solicitação (IUAtestado.aspx) não foi carregado na PCMS.');
    }

    // Aguarda os inputs estarem presentes no frame interno
    await frameAtestado.waitForSelector('#txtNome', { timeout: 15000 }).catch(() => {
      throw new Error('O campo #txtNome não foi renderizado no iframe da PCMS.');
    });

    // Normalização dos dados de entrada
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawRg = dados.rg || dados.numero || '';
    const rawName = dados.candidateName || dados.nome || '';
    const rawBirth = dados.candidateBirthDate || dados.dataNascimento || '';
    const rawMother = dados.motherName || dados.nomeMae || '';
    const rawFather = dados.fatherName || dados.nomePai || '';

    const cpfLimpo = String(rawCpf).replace(/\D/g, '');
    const rgLimpo = String(rawRg).replace(/\D/g, '');
    
    let dataFormatada = rawBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }

    // Preenchimento dos campos mapeados dentro do iframe com eventos nativos
    console.log('[PCMS] Preenchendo formulário interno...');
    await frameAtestado.evaluate((payload) => {
      const setFieldValue = (selector, val) => {
        const el = document.querySelector(selector);
        if (el && val) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      };

      setFieldValue('#txtNome', payload.nome);
      setFieldValue('#txtMae', payload.mae);
      setFieldValue('#txtPai', payload.pai);
      setFieldValue('#txtDataNascimento', payload.dataNascimento);

      // Define tipo de documento como CPF ou RG (conforme disponibilidade)
      const selectDoc = document.querySelector('#cmbTipoDocumento');
      if (selectDoc) {
        // Geralmente 1 ou CPF/RG dependendo do select options
        selectDoc.value = payload.cpf ? 'CPF' : 'RG';
        selectDoc.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setFieldValue('#txtNumeroDocumento', payload.cpf || payload.rg);
    }, {
      nome: rawName.toUpperCase().trim(),
      mae: rawMother.toUpperCase().trim(),
      pai: rawFather.toUpperCase().trim(),
      dataNascimento: dataFormatada,
      cpf: cpfLimpo,
      rg: rgLimpo
    });

    await new Promise(r => setTimeout(r, 1000));

    // Localiza e aciona o botão de pesquisa/emissão dentro do frame
    console.log('[PCMS] Acionando botão de emissão...');
    await frameAtestado.evaluate(() => {
      const botoes = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn'));
      const btnAlvo = botoes.find(b => {
        const txt = (b.innerText || b.value || '').toLowerCase();
        return txt.includes('pesquisar') || txt.includes('emitir') || txt.includes('consultar') || txt.includes('solicitar');
      });
      if (btnAlvo) {
        btnAlvo.click();
      } else if (botoes.length > 0) {
        botoes[0].click();
      }
    });

    // Aguarda o processamento e retorno da consulta
    let esperas = 0;
    while (!respostaApiJson && esperas < 20) {
      await new Promise(r => setTimeout(r, 400));
      esperas++;
    }

    // Captura texto da tela caso o retorno seja exibido diretamente via DOM/SweetAlert
    const textoTela = await frameAtestado.evaluate(() => {
      const swalText = document.querySelector('.sweet-alert p, .swal-text, .toast-message');
      return swalText ? swalText.innerText : document.body.innerText || '';
    });

    const textoMaiusculo = textoTela.toUpperCase();
    const temRegistros = textoMaiusculo.includes('REGISTRO LOCALIZADO') || textoMaiusculo.includes('CONSTA ANTECEDENTE');
    const negadaOuNegativa = textoMaiusculo.includes('NADA CONSTA') || textoMaiusculo.includes('NEGATIVA');

    if (!negadaOuNegativa && !temRegistros && !respostaApiJson) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'FALHA NA EXECUÇÃO PCMS',
        mensagem: 'Não foi possível confirmar o resultado da emissão na interface da PCMS.',
        rawSnippet: textoTela.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: temRegistros,
      riskLevel: temRegistros ? 'HIGH' : 'LOW',
      statusTexto: temRegistros ? 'REGISTRO LOCALIZADO' : 'CERTIDÃO NEGATIVA EMITIDA',
      mensagem: respostaApiJson?.mensagem || (temRegistros ? 'Registros criminais localizados na PCMS.' : 'Certidão Negativa emitida com sucesso pela PCMS.'),
      rawSnippet: textoTela.replace(/\s+/g, ' ').slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCMS] Erro crítico na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCMS',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCMS] Navegador encerrado com sucesso.`);
    }
  }
}
