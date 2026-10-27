import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPE(payload) {
  const URL_ALVO = 'https://www.servicos.sds.pe.gov.br/antecedentes/public/pages/certidaoAntecedentesCriminais/certidaoAntecedentesCriminaisEmitir.jsf';
  let browser = null;

  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const nomeMae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const nomePai = (dados.nomePai || dados.pai || '').toUpperCase().trim();
  const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
  const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');

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
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCPE] Acessando portal do IITB / PCPE para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('form', { timeout: 15000 }).catch(() => {});

    async function preencherInput(seletor, valor) {
      if (!valor) return;
      try {
        const el = await page.$(seletor);
        if (el) {
          await page.focus(seletor);
          await page.evaluate(s => document.querySelector(s).value = '', seletor);
          await page.type(seletor, String(valor), { delay: 20 });
        }
      } catch (e) {}
    }

    // Preenchimento de campos básicos
    await preencherInput('#formBody\\:campoNome', nome);
    await preencherInput('#formBody\\:campoNomeMae', nomeMae);
    if (nomePai) {
      await preencherInput('#formBody\\:campoNomePai', nomePai);
    }
    await preencherInput('#formBody\\:campoDataNascimento_input', dataNasc);
    await preencherInput('#formBody\\:campoCpf', cpfLimpo);
    if (rgLimpo) {
      await preencherInput('#formBody\\:campoRg', rgLimpo);
    }

    console.log('[PCPE] Submetendo requisição de certidão...');
    const botaoClicado = await page.evaluate(() => {
      const btn = document.querySelector('button[id$="j_idt97"], button[type="submit"], input[type="submit"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!botaoClicado) {
      await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    await new Promise(r => setTimeout(r, 3000));

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');
    const textoUpper = resultadoTexto.toUpperCase();

    if (textoUpper.includes('NADA CONSTA') || textoUpper.includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil de Pernambuco.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (textoUpper.includes('EXISTEM REGISTROS') || textoUpper.includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro processual/criminal na base da PCPE.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no sistema do IITB / PCPE.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error('[PCPE] Erro na execução:', error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCPE',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log('[PCPE] Navegador encerrado com sucesso.');
    }
  }
}
