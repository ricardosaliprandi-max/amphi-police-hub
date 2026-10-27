import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  const URL_ALVO = 'https://siscert.deic.rn.gov.br/';

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
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação rigorosa: bloqueia imagens, estilos, fontes e mídia para economizar RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCRN] Acessando portal SISCERT da PCRN para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário carregar
    await page.waitForSelector('form.form', { timeout: 15000 });

    // 1. Preenchimento do Nome Completo
    await page.type('input[name="nomeCompleto"]', dados.nome.toUpperCase().trim(), { delay: 30 });

    // 2. Preenchimento do CPF (apenas números, exatamente 11 dígitos)
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '').slice(0, 11);
    await page.type('input[name="cpf"]', cpfLimpo, { delay: 30 });

    // 3. Submissão (Gerar Declaração)
    console.log('[PCRN] Submetendo dados para geração da certidão...');
    
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
      page.click('button#btnDeclaracao')
    ]);

    // Analisa a página resultante
    const urlAtual = page.url();
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (urlAtual.includes('gerarDeclaracaoEmPDF') || resultadoTexto.toUpperCase().includes('DECLARAÇÃO') || resultadoTexto.toUpperCase().includes('CERTIDÃO')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO / DECLARAÇÃO GERADA',
        mensagem: 'Declaração de antecedentes criminais emitida com sucesso na base da PCRN.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCRN.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'CONSULTA PROCESSADA',
      mensagem: 'Solicitação submetida com sucesso no portal da PCRN.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCRN] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCRN] Navegador encerrado com sucesso.`);
    }
  }
}
