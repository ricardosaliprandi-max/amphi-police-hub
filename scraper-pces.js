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
        if (window
