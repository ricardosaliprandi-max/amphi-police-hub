import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRR(dados) {
  const URL_ALVO = 'http://antecedentes.ssp.rr.gov.br/pages/Atestado/IUAtestado.aspx';

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

    console.log(`[PCRR] Acessando portal de antecedentes da PCRR para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário ASP.NET carregar
    await page.waitForSelector('input', { timeout: 15000 });

    // 1. Preenchimento do Nome Completo
    const inputNome = await page.$('input[name*="Nome" i], input[id*="Nome" i]');
    if (inputNome) {
      await inputNome.type(dados.nome.toUpperCase().trim(), { delay: 30 });
    }

    // 2. Filiação 1 (Mãe)
    const inputMae = await page.$('input[name*="Filiacao1" i], input[id*="Filiacao1" i]');
    if (inputMae && dados.nomeMae) {
      await inputMae.type(dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // 3. Filiação 2 (Pai) - Opcional
    const inputPai = await page.$('input[name*="Filiacao2" i], input[id*="Filiacao2" i]');
    if (inputPai && dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await inputPai.type(dados.nomePai.toUpperCase().trim(), { delay: 30 });
    }

    // 4. Data de Nascimento
    const inputData = await page.$('input[name*="Nascimento" i], input[id*="Nascimento" i]');
    if (inputData) {
      let dataFormatada = dados.dataNascimento || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
        const [ano, mes, dia] = dataFormatada.split('-');
        dataFormatada = `${dia}/${mes}/${ano}`;
      }
      await inputData.type(dataFormatada, { delay: 40 });
    }

    // 5. Tipo de Documento e Número (CPF como preferência)
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    const docValor = cpfLimpo || rgLimpo;

    const selectTipoDoc = await page.$('select[name*="Tipo" i], select[id*="Tipo" i]');
    if (selectTipoDoc) {
      await selectTipoDoc.select(cpfLimpo ? 'CPF' : 'RG');
    }

    const inputDoc = await page.$('input[name*="Documento" i], input[id*="Documento" i], input[name*="Cpf" i], input[name*="Rg" i]');
    if (inputDoc) {
      await inputDoc.type(docValor, { delay: 30 });
    }

    // 6. Submissão (Gerar Certidão)
    console.log('[PCRR] Submetendo dados para emissão...');
    const btnGerar = await page.$('input[value*="Gerar Certidão" i], input[type="submit"]');
    if (btnGerar) {
      await Promise.all([
        btnGerar.click(),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
      ]);
    } else {
      await page.keyboard.press('Enter');
    }

    // Aguarda processamento
    await new Promise(r => setTimeout(r, 4000));
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil de Roraima.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCRR.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCRR.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCRR] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCRR] Navegador encerrado com sucesso.`);
    }
  }
}
