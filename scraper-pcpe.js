import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(payload) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  let browser = null;

  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const nomePai = (dados.nomePai || dados.pai || '').toUpperCase().trim();
  const nomeMae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const numeroDoc = String(dados.rg || dados.numero || dados.cpf || '').replace(/\D/g, '');

  let dataNasc = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
  }

  // Opções do Select PrimeFaces: 1=RG, 7=CNH, 12=CIN, 10=Passaporte, 4=CTPS[cite: 1]
  const tipoDocStr = (dados.tipoDocumento || 'RG').toUpperCase();
  let valorTipoDoc = '1';
  if (tipoDocStr.includes('CNH')) valorTipoDoc = '7';
  else if (tipoDocStr.includes('CIN')) valorTipoDoc = '12';
  else if (tipoDocStr.includes('PASSAPORTE')) valorTipoDoc = '10';
  else if (tipoDocStr.includes('CTPS')) valorTipoDoc = '4';

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-popup-blocking' // Libera a abertura de janelas filhas
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Interceptador direto caso window.open seja acionado pelo PrimeFaces
      window.__certidaoPopupUrl = null;
      const originalOpen = window.open;
      window.open = function(url, target, features) {
        window.__certidaoPopupUrl = url;
        return originalOpen.apply(this, arguments);
      };
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCES] Acessando portal SESP-ES para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('#numero', { timeout: 15000 });

    // 1. IP da Estação (exigência técnica do SESP-ES)[cite: 1, 3]
    try {
      await page.evaluate(async () => {
        try {
          const res = await fetch('https://api.ipify.org?format=json');
          const data = await res.json();
          const el = document.getElementById('idIPEstacao');
          if (el) {
            el.value = data.ip;
            if (typeof setarIpEstacaoBean === 'function') setarIpEstacaoBean();
          }
        } catch (e) {
          const el = document.getElementById('idIPEstacao');
          if (el) el.value = '177.185.0.1';
        }
      });
    } catch (e) {}

    // 2. Tipo de Documento (#j_idt57_input)[cite: 1, 3]
    await page.evaluate((val) => {
      const select = document.getElementById('j_idt57_input');
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(select).trigger('change');
      }
    }, valorTipoDoc);

    await new Promise(r => setTimeout(r, 600));

    // 3. Preenchimento dos Campos de Texto[cite: 1, 3]
    await page.type('#numero', numeroDoc, { delay: 25 });
    await page.type('#nomeIndividuo', nome, { delay: 20 });

    if (nomePai) {
      await page.type('#nomePai', nomePai, { delay: 20 });
    }
    if (nomeMae) {
      await page.type('#nomeMae', nomeMae, { delay: 20 });
    }

    // 4. Data de Nascimento (#dtNascimento_input)[cite: 1, 3]
    if (dataNasc) {
      await page.evaluate((dataStr) => {
        const inputData = document.getElementById('dtNascimento_input');
        if (inputData) {
          inputData.value = dataStr;
          inputData.dispatchEvent(new Event('input', { bubbles: true }));
          inputData.dispatchEvent(new Event('change', { bubbles: true }));
          inputData.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      }, dataNasc);
    }

    // 5. Preparar escuta de nova aba simultaneamente[cite: 1, 3]
    const popupTargetPromise = new Promise(resolve => {
      const listener = target => {
        if (target.type() === 'page' || target.url().includes('exibiratestado')) {
          browser.off('targetcreated', listener);
          resolve(target);
        }
      };
      browser.on('targetcreated', listener);
      setTimeout(() => {
        browser.off('targetcreated', listener);
        resolve(null);
      }, 10000);
    });

    // 6. Submissão via clique no botão oficial #btnPesquisar[cite: 1, 3]
    console.log('[PCES] Clicando em Emitir Atestado (#btnPesquisar)...');
    await page.click('#btnPesquisar');

    // Aguarda o processamento do AJAX do PrimeFaces (espera o StatusDialog fechar)[cite: 1, 3]
    await page.waitForFunction(() => {
      const statusDialog = document.getElementById('j_idt127');
      const dialogOculto = !statusDialog || statusDialog.classList.contains('ui-overlay-hidden');
      const popupInjetado = Boolean(window.__certidaoPopupUrl);
      const dlgPendencia = document.getElementById('j_idt101');
      const pendenciaAberta = dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden');
      const dlgInconsistente = document.getElementById('j_idt115');
      const inconsistenteAberto = dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden');

      return (dialogOculto && (popupInjetado || pendenciaAberta || inconsistenteAberto));
    }, { timeout: 12000 }).catch(() => {});

    // Verifica se capturou a nova página/aba pelo Puppeteer ou pelo window.open
    const popupTarget = await popupTargetPromise;
    const urlInterceptada = await page.evaluate(() => window.__certidaoPopupUrl);

    if (popupTarget || urlInterceptada) {
      console.log('[PCES] Sucesso absoluto: Nova guia de atestado detectada.');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Certidão de antecedentes criminais emitida com sucesso pela PCES (aberta em nova guia).',
        rawSnippet: urlInterceptada || popupTarget?.url() || 'exibiratestado.jsf'
      };
    }

    // 7. Avaliação dos Modais de Falha/Pendência se nenhuma aba abriu[cite: 1, 3]
    const resultadoDOM = await page.evaluate(() => {
      const dlgInconsistente = document.getElementById('j_idt115');
      const inconsistenteVisivel = dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden');

      const dlgPendencia = document.getElementById('j_idt101');
      const pendenciaVisivel = dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden');

      const growl = document.querySelector('#growlGeral, .ui-growl-message');
      const growlTexto = growl ? growl.innerText.trim() : '';

      return {
        inconsistenteVisivel,
        pendenciaVisivel,
        growlTexto,
        textoCorpo: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400)
      };
    });

    if (resultadoDOM.inconsistenteVisivel) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'PENDÊNCIA CADASTRAL / INSTITUCIONAL',
        mensagem: 'DADOS INCONSISTENTES: Envie cópia da carteira de identidade para instituto.identificacao@pci.es.gov.br.',
        rawSnippet: resultadoDOM.textoCorpo
      };
    }

    if (resultadoDOM.pendenciaVisivel) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'PENDÊNCIA DE ANTECEDENTES',
        mensagem: 'Encaminhe cópia de documento de identificação para atestado@pci.es.gov.br.',
        rawSnippet: resultadoDOM.textoCorpo
      };
    }

    if (resultadoDOM.growlTexto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'AVISO DO SISTEMA',
        mensagem: resultadoDOM.growlTexto,
        rawSnippet: resultadoDOM.textoCorpo
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'PROCESSADO SEM EMISSÃO',
      mensagem: 'Formulário submetido, porém nenhuma certidão ou modal foi disparado.',
      rawSnippet: resultadoDOM.textoCorpo
    };

  } catch (error) {
    console.error('[PCES] Erro:', error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCES',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
