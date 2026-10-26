import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPB(dados) {
  const URL_ALVO = 'https://antecedentes.ssp.pb.gov.br/'; // Ajuste conforme a URL exata do portal se necessário

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

    console.log(`[PCPB] Acessando portal da PCPB (Vsoft iDSPS) para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle2', timeout: 35000 });

    // Aguarda o formulário carregar
    await page.waitForSelector('form#form', { timeout: 15000 });

    // 1. Preenchimento de RG e Órgão Expedidor
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await page.type('input[name="rg"]', rgLimpo, { delay: 30 });
      await page.type('input[name="orgaoExpedidor"]', (dados.orgaoExpedidor || 'SSP').toUpperCase(), { delay: 30 });
    }

    // 2. Preenchimento do Nome Completo
    await page.type('input[name="nome"]', dados.nome.toUpperCase().trim(), { delay: 30 });

    // 3. Data de Nascimento (DD/MM/AAAA)
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await page.type('input[name="dataNascimento"]', dataFormatada, { delay: 40 });

    // 4. Preenchimento do CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await page.type('input[name="cpf"]', cpfLimpo, { delay: 30 });

    // 5. Filiação (Mãe e Pai)
    if (dados.nomeMae) {
      await page.type('input[name="mae"]', dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }
    if (dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await page.type('input[name="pai"]', dados.nomePai.toUpperCase().trim(), { delay: 30 });
    }

    // 6. Submissão (Clicar no botão "Emitir")
    console.log('[PCPB] Clicando no botão Emitir...');
    await Promise.all([
      page.click('button#btEmitir'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);

    // Aguarda eventual modal ou renderização de resultado
    await new Promise(r => setTimeout(r, 4000));

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil da Paraíba.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da PCPB.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no sistema da PCPB.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } finally {
    await browser.close();
  }
}
