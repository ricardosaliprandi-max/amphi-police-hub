import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(payload) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  let browser = null;

  const browserLogs = [];
  const execSteps = [];

  const logStep = (step, meta = {}) => {
    execSteps.push({ step, time: new Date().toISOString(), ...meta });
    console.log(`[PCES][STEP] ${step}`);
  };

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
    logStep('iniciando_browser');
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

    page.on('console', msg => {
      browserLogs.push(`[Console ${msg.type().toUpperCase()}] ${msg.text()}`);
    });
    page.on('pageerror', err => {
      browserLogs.push(`[Page Script Error] ${err.message}`);
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Interceptação global de window.open e openInNewTab
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.__certidaoUrlAberta = null;
      const originalOpen = window.open;
      window.open = function(url) {
        window.__certidaoUrlAberta = url;
        return originalOpen ? originalOpen.apply(this, arguments) : null;
      };
      window.openInNewTab = function(url) {
        window.__certidaoUrlAberta = url;
      };
    });

    // Otimização de RAM (bloqueia apenas imagens e fontes pesadas)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    logStep('navegando_portal_alvo', { url: URL_ALVO });
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('#formMaster', { timeout: 15000 });
    logStep('portal_carregado');

    // 1. IP da Estação[cite: 1]
    await page.evaluate(() => {
      const el = document.getElementById('idIPEstacao');
      if (el) el.value = '177.185.0.1';
      if (typeof setarIpEstacaoBean === 'function') {
        try { setarIpEstacaoBean(); } catch (e) {}
      }
    });
    logStep('ip_estacao_configurado');

    // 2. Seleção de Tipo de Documento via PrimeFaces API nativa[cite: 1]
    await page.evaluate(({ val, lbl }) => {
      if (window.PF && PF('widget_j_idt57')) {
        PF('widget_j_idt57').selectValue(val);
      } else {
        const select = document.getElementById('j_idt57_input');
        const label = document.getElementById('j_idt57_label');
        if (select) {
          select.value = val;
          if (label) label.innerText = lbl;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, { val: valorTipoDoc, lbl: labelTipoDoc });

    await new Promise(r => setTimeout(r, 600));
    logStep('documento_selecionado', { valorTipoDoc });

    // 3. Preenchimento de Número e Nome[cite: 1]
    await page.type('#numero', numeroDoc, { delay: 20 });
    await page.type('#nomeIndividuo', nome, { delay: 20 });

    if (nomePai) {
      await page.type('#nomePai', nomePai, { delay: 20 });
    }
    if (nomeMae) {
      await page.type('#nomeMae', nomeMae, { delay: 20 });
    }

    // 4. Data de Nascimento[cite: 1]
    if (dataNasc) {
      await page.focus('#dtNascimento_input');
      await page.type('#dtNascimento_input', dataNasc, { delay: 25 });
      await page.keyboard.press('Tab');
    }

    await new Promise(r => setTimeout(r, 500));
    logStep('dados_biograficos_preenchidos', { numeroDoc, dataNasc });

    // 5. Escuta de nova aba criada pelo navegador[cite: 1]
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
      }, 10000);
    });

    // 6. Submissão direta chamando a rotina AJAX do PrimeFaces com tratamento de resposta[cite: 1]
    logStep('disparando_ajax_primefaces');
    const ajaxIniciado = await page.evaluate(() => {
      try {
        if (window.PrimeFaces && typeof PrimeFaces.ab === 'function') {
          PrimeFaces.ab({
            source: 'btnPesquisar',
            process: 'btnPesquisar pngFiltro',
            update: 'growlGeral pngPrincipalPesquisarIndividuo',
            onstart: function(cfg) {
              if (window.PF && PF('wDlgStatusDialog')) PF('wDlgStatusDialog').show();
            },
            oncomplete: function(xhr, status, args) {
              if (window.PF && PF('wDlgStatusDialog')) PF('wDlgStatusDialog').hide();
              if (typeof abrirNovaAba === 'function') {
                abrirNovaAba();
              }
            }
          });
          return true;
        }
      } catch (e) {
        return false;
      }
      return false;
    });

    if (!ajaxIniciado) {
      logStep('fallback_clique_fisico');
      await page.click('#btnPesquisar');
    }

    // Aguarda 4 segundos para o processamento do AJAX do servidor
    logStep('aguardando_estabilizacao_resposta');
    await new Promise(r => setTimeout(r, 4500));

    // Checagem se nova guia foi detectada ou window.open disparado[cite: 1]
    const targetGuia = await novaGuiaPromise;
    const urlGuia = await page.evaluate(() => window.__certidaoUrlAberta);

    if (targetGuia || urlGuia) {
      logStep('certidao_emitida_em_nova_guia');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Certidão de antecedentes criminais emitida com sucesso pela PCES.',
        rawSnippet: urlGuia || targetGuia?.url() || 'exibiratestado.jsf',
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    // Checagem dos modais de retorno do PrimeFaces[cite: 1]
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

    logStep('diagnostico_dom_concluido', {
      inconsistente: diagnostico.inconsistenteVisivel,
      pendencia: diagnostico.pendenciaVisivel,
      temGrowl: Boolean(diagnostico.growlTexto)
    });

    if (diagnostico.inconsistenteVisivel) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: 'Dados inconsistentes com o Instituto de Identificação do ES. Envie cópia para instituto.identificacao@pci.es.gov.br.',
        rawSnippet: diagnostico.corpoTexto,
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    if (diagnostico.pendenciaVisivel) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'PENDÊNCIA CADASTRAL / APONTAMENTO',
        mensagem: 'Encaminhe cópia de documento de identificação para atestado@pci.es.gov.br.',
        rawSnippet: diagnostico.corpoTexto,
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    if (diagnostico.growlTexto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: diagnostico.growlTexto,
        rawSnippet: diagnostico.corpoTexto,
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Formulário submetido no portal da PCES.',
      rawSnippet: diagnostico.corpoTexto,
      debug: {
        etapasExecutadas: execSteps,
        logsNavegador: browserLogs
      }
    };

  } catch (error) {
    console.error(`[PCES] Erro:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCES',
      mensagem: error.message,
      debug: {
        etapasExecutadas: execSteps,
        logsNavegador: browserLogs,
        stackTrace: error.stack
      }
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
