import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCCE(payload) {
  const URL_ALVO = 'https://sistemas.sspds.ce.gov.br/AtestadoAntecedentes/index.do';
  let browser = null;

  // Normaliza o payload recebido do Hub
  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const mae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  
  // Regra estrita da PCCE: O RG não deve conter o dígito verificador
  let rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
  if (rgLimpo.length > 1) {
    rgLimpo = rgLimpo.slice(0, -1); // Remove o último dígito (verificador)
  }

  // Tratamento da data de nascimento para DD/MM/AAAA
  let dataNasc = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
  }

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
        '--single-process', // Essencial para gerir o limite de 512MB de RAM no Render
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação para poupar recursos de rede e memória RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCCE] Acessando portal oficial SSPDS-CE para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Preenchimento dos campos do formulário conforme IDs/Names reais mapeados no HTML[cite: 2]
    await page.waitForSelector('input[name="numRg"]', { timeout: 10000 }).catch(() => {});

    await page.type('input[name="numRg"]', rgLimpo, { delay: 30 });
    await page.type('input[name="nome"]', nome, { delay: 20 });
    await page.type('input[name="dataNasc"]', dataNasc, { delay: 20 });
    
    if (mae) {
      await page.type('input[name="mae"]', mae, { delay: 20 });
    }

    console.log('[PCCE] Submetendo formulário de consulta...');
    await Promise.all([
      page.click('input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
    ]);

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');
    const textoUpper = resultadoTexto.toUpperCase();

    // Verificação de erros ou avisos institucionais retornados pelo Ceará
    if (textoUpper.includes('NÃO FOI POSSÍVEL') || textoUpper.includes('DIRIGIR-SE') || textoUpper.includes('NÃO CONSTA EM NOSSA BASE')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'ATENDIMENTO PRESENCIA/RESTRIÇÃO',
        mensagem: 'O registro não consta na base digital da PCCE ou exige comparecimento à Coordenadoria de Identificação Humana (Benfica, Fortaleza).'
      };
    }

    if (textoUpper.includes('EXISTEM REGISTROS') || textoUpper.includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da Polícia Civil do Ceará.',
        rawSnippet: resultadoTexto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    if (textoUpper.includes('CERTIDÃO') || textoUpper.includes('NADA CONSTA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil do Ceará.',
        rawSnippet: resultadoTexto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCCE.',
      rawSnippet: resultadoTexto.replace(/\s+/g, ' ').slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCCE] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCCE',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCCE] Navegador encerrado com sucesso.`);
    }
  }
}
