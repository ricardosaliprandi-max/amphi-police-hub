import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCCE(payload) {
  const URL_ALVO = 'https://sistemas.sspds.ce.gov.br/AtestadoAntecedentes/index.do?action=ShowAtestado';
  let browser = null;

  // 1. Telemetria e Caixa-Preta Local
  const browserLogs = [];
  const execSteps = [];

  const logStep = (step, meta = {}) => {
    execSteps.push({ step, time: new Date().toISOString(), ...meta });
    console.log(`[PCCE][STEP] ${step}`);
  };

  // Normalização do Payload unificado
  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const mae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();

  // Regra técnica estrita da PCCE: Remover dígito verificador do RG
  let rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
  if (rgLimpo.length > 1) {
    rgLimpo = rgLimpo.slice(0, -1);
  }

  // Formatação de Data para DD/MM/AAAA
  let dataNasc = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
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

    // Listeners de Telemetria do Navegador
    page.on('console', msg => {
      browserLogs.push(`[Console ${msg.type().toUpperCase()}] ${msg.text()}`);
    });
    page.on('pageerror', err => {
      browserLogs.push(`[Page Script Error] ${err.message}`);
    });
    page.on('requestfailed', req => {
      browserLogs.push(`[Network Fail] ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Interceptação de window.open caso a emissão dispare nova guia
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.__certidaoUrlAberta = null;
      const originalOpen = window.open;
      window.open = function(url) {
        window.__certidaoUrlAberta = url;
        return originalOpen ? originalOpen.apply(this, arguments) : null;
      };
    });

    // Otimização de RAM
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

    // Aguarda o formulário carregar no DOM
    await page.waitForSelector('input[name="numRg"]', { timeout: 15000 });
    logStep('formulario_carregado');

    // Preenchimento dos campos mapeados no HTML
    await page.focus('input[name="numRg"]');
    await page.type('input[name="numRg"]', rgLimpo, { delay: 25 });

    await page.focus('input[name="nome"]');
    await page.type('input[name="nome"]', nome, { delay: 20 });

    if (dataNasc) {
      await page.focus('input[name="dataNasc"]');
      await page.type('input[name="dataNasc"]', dataNasc, { delay: 25 });
    }

    if (mae) {
      await page.focus('input[name="mae"]');
      await page.type('input[name="mae"]', mae, { delay: 20 });
    }

    logStep('dados_biograficos_preenchidos', { rgLimpo, dataNasc });

    // Monitoramento de abertura de nova guia caso ocorra redirecionamento
    const novaGuiaPromise = new Promise(resolve => {
      const listener = target => {
        if (target.type() === 'page') {
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

    // Submissão do formulário Struts
    logStep('submetendo_formulario');
    const submitBtn = await page.$('input[type="submit"][value="Pesquisar"], input[type="submit"]');

    if (submitBtn) {
      await Promise.all([
        submitBtn.click(),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
      ]);
    } else {
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    }

    logStep('navegacao_pos_submit_finalizada');

    // 1. Checagem de Nova Guia / Popup
    const targetGuia = await novaGuiaPromise;
    const urlGuia = await page.evaluate(() => window.__certidaoUrlAberta);

    if (targetGuia || urlGuia) {
      logStep('certidao_emitida_em_nova_guia');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Certidão de antecedentes criminais emitida com sucesso pela SSPDS / PCCE.',
        rawSnippet: urlGuia || targetGuia?.url() || 'atestado_emitido.html',
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    // 2. Extração e Diagnóstico do DOM retornado
    const diagnostico = await page.evaluate(() => {
      const errosEl = document.getElementById('errors');
      const errosTexto = errosEl ? errosEl.innerText.trim() : '';
      const corpoTexto = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';

      return {
        errosTexto,
        corpoTexto: corpoTexto.slice(0, 500)
      };
    });

    logStep('diagnostico_dom_concluido', { temErrosDiv: Boolean(diagnostico.errosTexto) });

    const textoAnalise = (diagnostico.errosTexto + ' ' + diagnostico.corpoTexto).toUpperCase();

    // Restrição institucional de atendimento presencial
    if (
      textoAnalise.includes('NÃO FOI POSSÍVEL') || 
      textoAnalise.includes('DIRIGIR-SE') || 
      textoAnalise.includes('NÃO CONSTAR EM NOSSA BASE') ||
      textoAnalise.includes('COORDENADORIA DE IDENTIFICAÇÃO HUMANA')
    ) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'ATENDIMENTO PRESENCIAL / RESTRIÇÃO CADASTRAL',
        mensagem: diagnostico.errosTexto || 'Registro não consta na base digital da PCCE ou exige comparecimento à Coordenadoria de Identificação Humana (Benfica, Fortaleza).',
        rawSnippet: diagnostico.corpoTexto,
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    // Apontamento criminal ou pendência processual
    if (textoAnalise.includes('EXISTEM REGISTROS') || textoAnalise.includes('APONTAMENTO') || textoAnalise.includes('PENDÊNCIA')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da Polícia Civil do Ceará.',
        rawSnippet: diagnostico.corpoTexto,
        debug: {
          etapasExecutadas: execSteps,
          logsNavegador: browserLogs
        }
      };
    }

    // Sucesso direto na mesma página
    if (textoAnalise.includes('NADA CONSTA') || textoAnalise.includes('ATESTADO DE ANTECEDENTES') || textoAnalise.includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil do Ceará.',
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
      mensagem: 'Consulta executada no portal da PCCE.',
      rawSnippet: diagnostico.corpoTexto,
      debug: {
        etapasExecutadas: execSteps,
        logsNavegador: browserLogs
      }
    };

  } catch (error) {
    console.error(`[PCCE] Erro:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCCE',
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
      console.log('[PCCE] Instância do navegador encerrada.');
    }
  }
}
