import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCSC(dados) {
  const URL_ALVO = 'https://delegaciavirtual.sc.gov.br/atestado-antecedentes/novo';

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

    console.log(`[PCSC] Acessando Delegacia Virtual de Santa Catarina para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário renderizar na página
    await page.waitForSelector('form, input', { timeout: 15000 });

    // 1. Validar regra de UF do RG (Exigência restrita de SC para o canal digital)
    const ufRg = (dados.ufRg || dados.uf || 'SC').toUpperCase();
    if (ufRg !== 'SC') {
      return {
        sucesso: false,
        canalInstitucional: true,
        statusTexto: 'EXIGE RG DE SANTA CATARINA',
        mensagem: 'O portal online da PCSC processa digitalmente apenas RGs emitidos em Santa Catarina. Documentos de outros estados exigem solicitação via canal de atendimento da DIPC.'
      };
    }

    // 2. Preenchimento de Data de Nascimento
    const inputData = await page.$('input[name*="data" i], input[placeholder*="data" i], input[id*="data" i]');
    if (inputData && dados.dataNascimento) {
      let dataFormatada = dados.dataNascimento;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
        const [ano, mes, dia] = dataFormatada.split('-');
        dataFormatada = `${dia}/${mes}/${ano}`;
      }
      await inputData.type(dataFormatada, { delay: 40 });
    }

    // 3. Preenchimento do CPF
    const inputCpf = await page.$('input[name*="cpf" i], input[id*="cpf" i]');
    if (inputCpf) {
      const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
      await inputCpf.type(cpfLimpo, { delay: 30 });
    }

    // 4. Preenchimento do RG (sem dígito verificador, conforme orientação do portal de SC)
    const inputRg = await page.$('input[name*="rg" i], input[id*="rg" i]');
    if (inputRg) {
      let rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
      if (rgLimpo.length > 1) {
        rgLimpo = rgLimpo.slice(0, -1); 
      }
      await inputRg.type(rgLimpo, { delay: 30 });
    }

    // 5. Seleção da UF do RG (Santa Catarina)
    const selectUf = await page.$('select[name*="uf" i], select[id*="uf" i]');
    if (selectUf) {
      await page.select('select[name*="uf" i], select[id*="uf" i]', 'SANTA CATARINA');
    }

    // 6. Submissão (Solicitar Atestado de Antecedentes)
    console.log('[PCSC] Submetendo solicitação de atestado...');
    const btnSolicitar = await page.$('button[type="submit"], input[type="submit"], button:has-text("Solicitar")');
    if (btnSolicitar) {
      await Promise.all([
        btnSolicitar.click(),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
      ]);
    } else {
      await page.keyboard.press('Enter');
    }

    await new Promise(r => setTimeout(r, 4000));
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros da Polícia Civil de Santa Catarina.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCSC.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da Delegacia Virtual de SC.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCSC] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCSC] Navegador encerrado com sucesso.`);
    }
  }
}
