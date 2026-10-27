import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(payload) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  let browser = null;

  // 1. Normalização do Payload (lê tanto sub-objeto dados quanto propriedades diretas)
  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const nomePai = (dados.nomePai || dados.pai || '').toUpperCase().trim();
  const nomeMae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const numeroDoc = String(dados.rg || dados.numero || dados.cpf || '').replace(/\D/g, '');

  // 2. Formatação da Data de Nascimento para o padrão DD/MM/AAAA exigido pelo PrimeFaces Calendar
  let dataNasc = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
  }

  // 3. Mapeamento do Tipo de Documento no select #j_idt57_input (1=RG, 7=CNH, 12=CIN, etc.)
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
        '--disable-popup-blocking' // Permite que a função openInNewTab execute sem bloqueio de popup
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Camuflagem e interceptação de window.open direto no contexto da página
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.__certidaoAbertaUrl = null;
      const originalOpen = window.open;
      window.open = function(url) {
        window.__certidaoAbertaUrl = url;
        return originalOpen ? originalOpen.apply(this, arguments) : null;
      };
    });

    // Bloqueio de mídia/fontes pesadas para manter a RAM do Render abaixo de 512MB
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCES] Conectando ao portal SESP-ES para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário carregar
    await page.waitForSelector('#numero', { timeout: 15000 });

    // Injeção do IP da Estação (#idIPEstacao e setarIpEstacaoBean)
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

    // Seleção do Tipo de Documento no Select PrimeFaces
    await page.evaluate((val) => {
      const select = document.getElementById('j_idt57_input');
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(select).trigger('change');
      }
    }, valorTipoDoc);

    await new Promise(r => setTimeout(r, 600));

    // Preenchimento dos campos do formulário
    await page.type('#numero', numeroDoc, { delay: 25 });
    await page.type('#nomeIndividuo', nome, { delay: 20 });

    if (nomePai) {
      await page.type('#nomePai', nomePai, { delay: 20 });
    }
    if (nomeMae) {
      await page.type('#nomeMae', nomeMae, { delay: 20 });
    }

    // Injeção da data no componente PrimeFaces Calendar com disparo de eventos
    if (dataNasc) {
      await page.evaluate((val) => {
        const input = document.getElementById('dtNascimento_input');
        if (input) {
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      }, dataNasc);
    }

    // Monitoramento simultâneo de nova aba aberta pelo Puppeteer
    const novaAbaPromise = new Promise(resolve => {
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

    // Submissão do formulário via clique AJAX no botão #btnPesquisar (SEM waitForNavigation)
    console.log('[PCES] Submetendo pesquisa via AJAX (#btnPesquisar)...');
    await page.click('#btnPesquisar');

    // Aguarda o término da chamada AJAX: espera o modal de loading (wDlgStatusDialog / #j_idt127) sumir ou surgir uma ação
    await page.waitForFunction(() => {
      const statusDialog = document.getElementById('j_idt127');
      const dialogFechado = !statusDialog || statusDialog.classList.contains('ui-overlay-hidden');
      const popupAcionado = Boolean(window.__certidaoAbertaUrl);
      
      const dlgPendencia = document.getElementById('j_idt101');
      const pendenciaAberta = dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden');

      const dlgInconsistente = document.getElementById('j_idt115');
      const inconsistenteAberto = dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden');

      return dialogFechado && (popupAcionado || pendenciaAberta || inconsistenteAberto);
    }, { timeout: 15000 }).catch(() => {});

    // 1. CHECAGEM DE SUCESSO: A nova guia de atestado foi aberta?
    const targetAba = await novaAbaPromise;
    const urlAbaAberta = await page.evaluate(() => window.__certidaoAbertaUrl);

    if (targetAba || urlAbaAberta) {
      console.log('[PCES] Certidão gerada em nova guia com sucesso!');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Certidão de antecedentes criminais emitida com sucesso pela PCES.',
        rawSnippet: urlAbaAberta || targetAba?.url() || 'exibiratestado.jsf'
      };
    }

    // 2. CHECAGEM DE MODAIS / ERROS: Se não abriu guia, o que a página renderizou?
    const diagnosticoDOM = await page.evaluate(() => {
      const dlgPendencia = document.getElementById('j_idt101');
      const pendenciaVisivel = dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden');

      const dlgInconsistente = document.getElementById('j_idt115');
      const inconsistenteVisivel = dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden');

      const growl = document.querySelector('#growlGeral, .ui-growl-message');
      const growlTexto = growl ? growl.innerText.trim() : '';

      return {
        pendenciaVisivel,
        inconsistenteVisivel,
        growlTexto,
        bodyTexto: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400)
      };
    });

    if (diagnosticoDOM.inconsistenteVisivel) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: 'Dados inconsistentes com o Instituto de Identificação do ES. Envie cópia para instituto.identificacao@pci.es.gov.br.',
        rawSnippet: diagnosticoDOM.bodyTexto
      };
    }

    if (diagnosticoDOM.pendenciaVisivel) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'PENDÊNCIA CADASTRAL / APONTAMENTO',
        mensagem: 'Encaminhe cópia de documento de identificação para atestado@pci.es.gov.br.',
        rawSnippet: diagnosticoDOM.bodyTexto
      };
    }

    if (diagnosticoDOM.growlTexto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: diagnosticoDOM.growlTexto,
        rawSnippet: diagnosticoDOM.bodyTexto
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'A solicitação foi enviada, mas o portal não abriu nova guia nem exibiu modais cadastrais.',
      rawSnippet: diagnosticoDOM.bodyTexto
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
      console.log(`[PCES] Instância do navegador encerrada.`);
    }
  }
}
