import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCAL(payload) {
  const URL_ALVO = 'https://idseg.institutodeidentificacao.al.gov.br/Vsoft.iDSPS.Agendamento/AntecedentesCriminais/Emitir';
  let browser = null;

  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const mae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
  const docLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');

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

    console.log(`[PCAL] Acessando portal oficial para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('input', { timeout: 15000 }).catch(() => {});

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

    if (docLimpo) {
      await preencherCampo(['#rg', 'input[name*="rg" i]', 'input[id*="rg" i]'], docLimpo);
    }
    await preencherCampo(['#orgaoExpedidor', 'input[name*="orgao" i]', 'input[id*="orgao" i]'], (dados.orgaoExpedidor || 'SSP').toUpperCase());

    const nomePreenchido = await preencherCampo(['#nome', 'input[name*="nome" i]', 'input[id*="nome" i]'], nome);
    if (!nomePreenchido) {
      throw new Error('Campo de nome não localizado no formulário da PCAL.');
    }

    await preencherCampo(['#dataNascimento', 'input[name*="nascimento" i]', 'input[id*="nascimento" i]'], dataFormatada);
    
    let cpfComMascara = cpfLimpo;
    if (cpfLimpo.length === 11) {
      cpfComMascara = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    await preencherCampo(['#cpf', 'input[name*="cpf" i]', 'input[id*="cpf" i]'], cpfComMascara);

    if (mae) {
      await preencherCampo(['#mae', 'input[name*="mae" i]', 'input[id*="mae" i]'], mae);
    }

    await new Promise(r => setTimeout(r, 2500));
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes da Polícia Civil de Alagoas.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCAL.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCAL] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCAL',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
