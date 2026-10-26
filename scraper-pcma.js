import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMA(dados) {
  // URL padrão oficial de antecedentes do Maranhão (ajuste se houver subdiretório específico no deploy)
  const URL_ALVO = 'https://antecedentes.ssp.ma.gov.br';

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

    console.log(`[PCMA] Acessando portal de antecedentes da SSP-MA para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle2', timeout: 35000 });

    // Aguarda a aplicação SPA renderizar os componentes do formulário no DOM
    await page.waitForSelector('input', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000)); // Tempo para hidratação do JS

    // 1. Preenchimento do CPF
    const cpfInput = await page.$('input[name*="cpf" i], input[placeholder*="CPF" i], input[formcontrolname*="cpf" i]');
    if (cpfInput) {
      const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
      await cpfInput.type(cpfLimpo, { delay: 30 });
    }

    // 2. Preenchimento do Nome Completo
    const nomeInput = await page.$('input[name*="nome" i], input[placeholder*="nome" i], input[formcontrolname*="nome" i]');
    if (nomeInput) {
      await nomeInput.type(dados.nome.toUpperCase().trim(), { delay: 30 });
    }

    // 3. Preenchimento da Data de Nascimento
    const dataInput = await page.$('input[name*="nasc" i], input[placeholder*="data" i], input[placeholder*="dd/mm" i]');
    if (dataInput) {
      let dataFormatada = dados.dataNascimento || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
        const [ano, mes, dia] = dataFormatada.split('-');
        dataFormatada = `${dia}/${mes}/${ano}`;
      }
      await dataInput.type(dataFormatada, { delay: 40 });
    }

    // 4. Preenchimento do Nome da Mãe (se solicitado pelo fluxo da tela)
    const maeInput = await page.$('input[name*="mae" i], input[placeholder*="mãe" i]');
    if (maeInput && dados.nomeMae) {
      await maeInput.type(dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // 5. Acionar o Botão de Consulta / Pesquisa
    const btnPesquisar = await page.$('button[type="submit"], input[type="submit"], button:has-text("Pesquisar"), button:has-text("Consultar"), button:has-text("Emitir")');
    if (btnPesquisar) {
      console.log('[PCMA] Submetendo formulário de consulta...');
      await btnPesquisar.click();
    } else {
      // Fallback: pressionar Enter caso o botão não tenha seletor direto
      await page.keyboard.press('Enter');
    }

    // Aguarda o retorno da API / renderização do resultado
    await new Promise(r => setTimeout(r, 5000));
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    // Análise de Resposta
    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes da Polícia Civil do Maranhão.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('REGISTRO') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da SSP-MA.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'CONSULTA REALIZADA',
      mensagem: 'Solicitação processada no portal da SSP-MA.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } finally {
    await browser.close();
  }
}
