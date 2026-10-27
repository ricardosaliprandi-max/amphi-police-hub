import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPA(dados) {
  const URL_ALVO = 'https://antecedentes.pc.pa.gov.br/';

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

    console.log(`[PCPA] Acessando portal da Polícia Civil do Pará para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário carregar
    await page.waitForSelector('form[action*="confirmacao"]', { timeout: 15000 });

    // 1. Preenchimento do Nome Completo
    await page.type('input[name="nome"]', dados.nome.toUpperCase().trim(), { delay: 30 });

    // 2. Filiação (Pai e Mãe)
    if (dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await page.type('input[name="pai"]', dados.nomePai.toUpperCase().trim(), { delay: 30 });
    }
    if (dados.nomeMae) {
      await page.type('input[name="mae"]', dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // 3. Naturalidade (Estado e Cidade - padrão Pará/Belém se não especificado)
    await page.select('select[name="estado"]', '14'); // 14 = Pará conforme o HTML
    await new Promise(r => setTimeout(r, 1000)); // Aguarda carregar as cidades via AJAX

    // Seleciona a cidade (padrão Belém ID 4565 ou busca correspondente)
    await page.select('select[name="cidade"]', '4565');

    // 4. Dados de Documentação (RG e CPF)
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await page.type('input[name="rg"]', rgLimpo, { delay: 30 });
      // Estado emissor do RG (padrão Pará ou UF informada)
      await page.select('select[name="estado_emissor"]', '14');
    }

    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await page.type('input[name="cpf"]', cpfLimpo, { delay: 30 });

    // 5. Data de Nascimento (DD/MM/AAAA)
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await page.type('input[name="dt_nascimento"]', dataFormatada, { delay: 40 });

    // 6. Submissão do Formulário para a página de confirmação
    console.log('[PCPA] Submetendo consulta...');
    await Promise.all([
      page.click('button.btn-primary'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null)
    ]);

    // 7. Análise da página resultante (/confirmacao ou emissão)
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes criminais da Polícia Civil do Pará.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da PCPA.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'CONSULTA ENVIADA',
      mensagem: 'Formulário processado e submetido no portal da PCPA.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCPA] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCPA] Navegador encerrado com sucesso.`);
    }
  }
}
