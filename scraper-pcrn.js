import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  const URL_ALVO = 'https://siscert.deic.rn.gov.br/'; // URL base padrão do sistema SISCERT da PCRN (ajuste se houver subdomínio específico)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[PCRN] Acessando portal SISCERT da PCRN para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle2', timeout: 35000 });

    // Aguarda o formulário carregar
    await page.waitForSelector('form.form', { timeout: 15000 });

    // 1. Preenchimento do Nome Completo
    await page.type('input[name="nomeCompleto"]', dados.nome.toUpperCase().trim(), { delay: 30 });

    // 2. Preenchimento do CPF (apenas números, exatamente 11 dígitos)
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '').slice(0, 11);
    await page.type('input[name="cpf"]', cpfLimpo, { delay: 30 });

    // 3. Submissão (Gerar Declaração)
    console.log('[PCRN] Submetendo dados para geração da certidão...');
    
    // Como a action é GET, o clique no botão ou submissão direta acionará o endpoint de PDF
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => null),
      page.click('button#btnDeclaracao')
    ]);

    // Analisa a página resultante (se gerou o PDF diretamente ou exibiu mensagem)
    const urlAtual = page.url();
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    // Se a URL redirecionou para o PDF ou o texto contém termos de certidão válida
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

  } finally {
    await browser.close();
  }
}
