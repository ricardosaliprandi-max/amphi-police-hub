import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(payload) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  let browser = null;

  // Normalização do Payload
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

  // 1 = RG, 7 = CNH, 12 = CIN
  const tipoDocStr = (dados.tipoDocumento || 'RG').toUpperCase();
  let valorTipoDoc = '1';
  let labelTipoDoc = 'CARTEIRA DE IDENTIDADE (RG)';
  if (tipoDocStr.includes('CNH')) {
    valorTipoDoc = '7';
    labelTipoDoc = 'CNH';
  } else if (tipoDocStr.includes('CIN')) {
    valorTipoDoc = '12';
    labelTipoDoc = 'CIN';
  }

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
        '--disable-popup-blocking'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Interceptação de janelas e bloqueio de popups via context script
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.__certidaoUrlAberta = null;
      const originalOpen = window.open;
      window.open = function(url) {
        window.__certidaoUrlAberta = url;
        return originalOpen ? originalOpen.apply(this, arguments) : null;
      };
    });

    // Otimização de RAM: abortar mídias pesadas
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCES] Acessando SESP-ES para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('#formMaster', { timeout: 15000 });

    // 1. IP da Estação (#idIPEstacao)
    try {
      await page.evaluate(() => {
        const el = document.getElementById('idIPEstacao');
        if (el) el.value = '177.185.0.1';
      });
    } catch (e) {}

    // 2. Seleção do Tipo de Documento no PrimeFaces (atualiza input e label visual)
    await page.evaluate(({ val, lbl }) => {
      const select = document.getElementById('j_idt57_input');
      const label = document.getElementById('j_idt57_label');
      if (select) {
        select.value = val;
        if (label) label.innerText = lbl;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(select).trigger('change');
      }
    }, { val: valorTipoDoc, lbl: labelTipoDoc });

    await new Promise(r => setTimeout(r, 600));

    // 3. Preenchimento de Número e Nome
    await page.type('#numero', numeroDoc, { delay: 20 });
    await page.type('#nomeIndividuo', nome, { delay: 20 });

    if (nomePai) {
      await page.type('#nomePai', nomePai, { delay: 20 });
    }
    if (nomeMae) {
      await page.type('#nomeMae', nomeMae, { delay: 20 });
    }

    // 4. Data de Nascimento no p:calendar
    if (dataNasc) {
      await page.focus('#dtNascimento_input');
      await page.type('#dtNascimento_input', dataNasc, { delay: 30 });
      await page.keyboard.press('Tab');
    }

    await new Promise(r => setTimeout(r, 500));

    // 5. Escuta de abertura de nova guia (quando a certidão é gerada)
    const novaGuiaPromise = new Promise(resolve => {
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
      }, 12000);
    });

    // 6. Submissão direta clicando no botão #btnPesquisar
    console.log('[PCES] Disparando clique em #btnPesquisar...');
    await page.evaluate(() => {
      const btn = document.getElementById('btnPesquisar');
      if (btn) btn.click();
    });

    // Aguarda o término da requisição AJAX do PrimeFaces
    await page.waitForFunction(() => {
      const popupInjetado = Boolean(window.__certidaoUrlAberta);
      const dlgPendencia = document.getElementById('j_idt101');
      const pendenciaAberta = dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden');
      const dlgInconsistente = document.getElementById('j_idt115');
      const inconsistenteAberto = dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden');
      const growl = document.querySelector('#growlGeral .ui-growl-message, .ui-messages-error');
      const temGrowl = Boolean(growl && growl.innerText.trim());

      return popupInjetado || pendenciaAberta || inconsistenteAberto || temGrowl;
    }, { timeout: 15000 }).catch(() => {});

    // Checagem se a nova aba foi aberta (Sucesso / Certidão Emitida)
    const targetGuia = await novaGuiaPromise;
    const urlGuia = await page.evaluate(() => window.__certidaoUrlAberta);

    if (targetGuia || urlGuia) {
      console.log('[PCES] Certidão emitida com sucesso (aberta em nova aba).');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Certidão de antecedentes criminais emitida com sucesso pela PCES.',
        rawSnippet: urlGuia || targetGuia?.url() || 'exibiratestado.jsf'
      };
    }

    // Checagem do estado dos modais no DOM
    const diagnostico = await page.evaluate(() => {
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
        corpoTexto: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300)
      };
    });

    if (diagnostico.inconsistenteVisivel) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: 'Dados inconsistentes com o Instituto de Identificação do ES. Envie cópia para instituto.identificacao@pci.es.gov.br.',
        rawSnippet: diagnostico.corpoTexto
      };
    }

    if (diagnostico.pendenciaVisivel) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'PENDÊNCIA CADASTRAL / APONTAMENTO',
        mensagem: 'Encaminhe cópia de documento de identificação para atestado@pci.es.gov.br.',
        rawSnippet: diagnostico.corpoTexto
      };
    }

    if (diagnostico.growlTexto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: diagnostico.growlTexto,
        rawSnippet: diagnostico.corpoTexto
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Formulário submetido no portal da PCES.',
      rawSnippet: diagnostico.corpoTexto
    };

  } catch (error) {
    console.error(`[PCES] Erro:`, error.message);
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
