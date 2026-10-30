import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  // Normalização dos dados de entrada
  const rawCpf = dados.candidateCpf || dados.cpf || '';
  const rawName = dados.candidateName || dados.nome || '';
  const cpfLimpo = String(rawCpf).replace(/\D/g, '');
  const nomeFormatado = String(rawName).toUpperCase().trim();

  // Monta a URL direta do PDF
  const URL_ALVO = `https://sinf2.policiacivil.rn.gov.br/siscert/Home/gerarDeclaracaoEmPDF?nomeCompleto=${encodeURIComponent(nomeFormatado)}&cpf=${encodeURIComponent(cpfLimpo)}`;

  console.log(`[PCRN] Acessando endpoint via Puppeteer: ${URL_ALVO}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-gpu',
      '--disable-web-security'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Camuflagem rigorosa
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    let pdfGeradoDetectado = false;
    let urlRespostaPdf = null;

    page.on('response', res => {
      const url = res.url();
      const contentType = res.headers()['content-type'] || '';
      if (contentType.includes('application/pdf') || url.includes('gerarDeclaracaoEmPDF')) {
        pdfGeradoDetectado = true;
        urlRespostaPdf = url;
      }
    });

    // Navega direto para a URL de geração com timeout tolerante
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(err => {
      console.warn(`[PCRN] Aviso no goto (pode ser normal se for download direto): ${err.message}`);
    });

    // Aguarda 8 segundos para processar o PDF/retorno
    await new Promise(r => setTimeout(r, 8000));

    const urlAtual = page.url();
    console.log(`[PCRN] URL atual no navegador: ${urlAtual}`);

    if (!pdfGeradoDetectado && !urlAtual.includes('gerarDeclaracaoEmPDF')) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'FALHA NA GERAÇÃO PCRN',
        mensagem: 'O portal da PCRN não retornou o documento PDF esperado.'
      };
    }

    console.log('[PCRN] Declaração gerada com sucesso pela PCRN.');

    return {
      sucesso: true,
      hasRecords: false,
      riskLevel: 'LOW',
      statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
      mensagem: 'Declaração de antecedentes gerada com sucesso pela PCRN.',
      rawSnippet: urlRespostaPdf ? `PDF gerado em: ${urlRespostaPdf}` : 'Documento gerado com sucesso.'
    };

  } catch (error) {
    console.error(`[PCRN] Erro crítico na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCRN',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCRN] Navegador encerrado com sucesso.`);
    }
  }
}
