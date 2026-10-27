import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMA(payload) {
  const URL_ALVO = 'https://antecedentes.ssp.ma.gov.br';
  let browser = null;

  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const mae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');

  let dataFormatada = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
    const [ano, mes, dia] = dataFormatada.split('-');
    dataFormatada = `${dia}/${mes}/${ano}`;
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
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCMA] Acessando portal de antecedentes da SSP-MA para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('input', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000)); // Aguarda hidratação do SPA Vue/Vite

    async function preencherCampo(seletores, valor) {
      if (!valor) return false;
      for (const seletor of seletores) {
        try {
          const el = await page.$(seletor);
          if (el) {
            await page.focus(seletor);
            await page.evaluate(s => document.querySelector(s).value = '', seletor);
            await page.type(seletor, String(valor), { delay: 25 });
            return true;
          }
        } catch (e) {}
      }
      return false;
    }

    await preencherCampo(['input[name*="cpf" i]', 'input[placeholder*="CPF" i]', 'input[formcontrolname*="cpf" i]'], cpfLimpo);
    await preencherCampo(['input[name*="nome" i]', 'input[placeholder*="nome" i]', 'input[formcontrolname*="nome" i]'], nome);
    await preencherCampo(['input[name*="nascimento" i]', 'input[placeholder*="nascimento" i]', 'input[formcontrolname*="nascimento" i]'], dataFormatada);
    
    if (mae) {
      await preencherCampo(['input[name*="mae" i]', 'input[placeholder*="mãe" i]', 'input[formcontrolname*="mae" i]'], mae);
    }

    await new Promise(r => setTimeout(r, 2000));
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes da Polícia Civil do Maranhão.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'CONSULTA REALIZADA',
      mensagem: 'Solicitação processada no portal da SSP-MA.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCMA] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCMA',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
