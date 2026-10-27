import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(payload) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  let browser = null;

  // Normaliza o payload recebido do Hub
  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const nomePai = (dados.nomePai || dados.pai || '').toUpperCase().trim();
  const nomeMae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const numeroDoc = String(dados.rg || dados.numero || dados.cpf || '').replace(/\D/g, '');
  
  // Tratamento da data de nascimento para DD/MM/AAAA
  let dataNasc = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
  }

  // Mapeamento do tipo de documento conforme o select PrimeFaces (#j_idt57_input)
  const tipoDocStr = (dados.tipoDocumento || 'RG').toUpperCase();
  let valorTipoDoc = "1"; // Padrão RG
  if (tipoDocStr.includes('CNH')) valorTipoDoc = "7";
  else if (tipoDocStr.includes('CIN')) valorTipoDoc = "12";
  else if (tipoDocStr.includes('PASSAPORTE')) valorTipoDoc = "10";
  else if (tipoDocStr.includes('CTPS')) valorTipoDoc = "4";

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
        '--single-process', // Essencial para o limite de 512MB de RAM no Render
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Camuflagem anti-bot e headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Interceptação para economizar banda e RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCES] Acessando portal oficial para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o carregamento dos elementos principais do formulário PrimeFaces
    await page.waitForSelector('#numero', { timeout: 15000 }).catch(() => {});

    // Injeção de IP da estação exigida pelo portal SESP-ES (via api.ipify.org)[cite: 2]
    try {
      const ipExterno = await page.evaluate(async () => {
        try {
          const res = await fetch('https://api.ipify.org?format=json');
          const data = await res.json();
          return data.ip;
        } catch (e) {
          return '177.185.0.1';
        }
      });
      await page.evaluate((ip) => {
        const inputIp = document.querySelector('#idIPEstacao');
        if (inputIp) {
          inputIp.value = ip;
        }
      }, ipExterno);
    } catch (err) {
      console.log('[PCES] Aviso ao injetar IP da estação, prosseguindo...');
    }

    // Seleção do Tipo de Documento no Select PrimeFaces
    await page.evaluate((val) => {
      const select = document.querySelector('#j_idt57_input');
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(select).trigger('change');
      }
    }, valorTipoDoc);

    // Preenchimento dos campos biográficos e número do documento
    await page.type('#numero', numeroDoc, { delay: 30 });
    await page.type('#nomeIndividuo', nome, { delay: 20 });
    
    if (nomePai) {
      await page.type('#nomePai', nomePai, { delay: 20 });
    }
    if (nomeMae) {
      await page.type('#nomeMae', nomeMae, { delay: 20 });
    }
    if (dataNasc) {
      await page.type('#dtNascimento_input', dataNasc, { delay: 20 });
    }

    // Disparo da consulta clicando no botão oficial #btnPesquisar[cite: 2]
    console.log('[PCES] Submetendo formulário de pesquisa...');
    await Promise.all([
      page.click('#btnPesquisar'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    ]);

    // Análise do resultado na página ou captura de diálogos modais do PrimeFaces
    const resultadoAnalise = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      
      // Verifica modais de pendência ou inconsistência institucional do ES[cite: 2]
      const dlgPendencia = document.querySelector('#j_idt101');
      if (dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden')) {
        return { tipo: 'PENDENCIA', texto: 'Encaminhe cópia de documento para atestado@pci.es.gov.br conforme exigência da PCES.' };
      }
      
      const dlgInconsistente = document.querySelector('#j_idt115');
      if (dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden')) {
        return { tipo: 'INCONSISTENTE', texto: 'Dados inconsistentes com o Instituto de Identificação do ES. Exige envio presencial/digital.' };
      }

      return { tipo: 'TEXTO', texto: bodyText };
    });

    if (resultadoAnalise.tipo === 'PENDENCIA' || resultadoAnalise.tipo === 'INCONSISTENTE') {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'PENDÊNCIA CADASTRAL / INSTITUCIONAL',
        mensagem: resultadoAnalise.texto
      };
    }

    const textoTotal = resultadoAnalise.texto.toUpperCase();

    if (textoTotal.includes('ORACLE ACCESS MANAGER') || textoTotal.includes('FATAL ERROR')) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'BLOQUEIO DE FIREWALL (OAM)',
        mensagem: 'O portal da SESP-ES barrou a conexão automatizada por restrição de segurança WAF/OAM.'
      };
    }

    if (textoTotal.includes('NADA CONSTA') || textoTotal.includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
        rawSnippet: resultadoAnalise.texto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    if (textoTotal.includes('EXISTEM REGISTROS') || textoTotal.includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da PCES.',
        rawSnippet: resultadoAnalise.texto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCES.',
      rawSnippet: resultadoAnalise.texto.replace(/\s+/g, ' ').slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCES] Erro crítico na execução:`, error?.message || error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCES',
      mensagem: error?.message || 'Erro desconhecido'
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCES] Navegador encerrado com sucesso.`);
    }
  }
}
