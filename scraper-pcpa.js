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

    // Aguarda o formulário carregar de forma genérica
    await page.waitForSelector('form, input', { timeout: 15000 }).catch(() => {});

    // Função auxiliar segura para preencher inputs
    async function preencherCampo(seletor, valor) {
      if (!valor) return;
      try {
        const el = await page.$(seletor);
        if (el) {
          await page.focus(seletor);
          await page.evaluate(s => document.querySelector(s).value = '', seletor);
          await page.type(seletor, String(valor), { delay: 30 });
          return true;
        }
      } catch (e) {
        // Ignora se não encontrar
      }
      return false;
    }

    // 1. Preenchimento do Nome Completo
    await preencherCampo('input[name="nome"], input[id*="nome" i]', dados.nome.toUpperCase().trim());

    // 2. Filiação (Pai e Mãe)
    if (dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await preencherCampo('input[name="pai"], input[id*="pai" i]', dados.nomePai.toUpperCase().trim());
    }
    if (dados.nomeMae) {
      await preencherCampo('input[name="mae"], input[id*="mae" i]', dados.nomeMae.toUpperCase().trim());
    }

    // 3. Naturalidade (Estado e Cidade)
    try {
      const selectEstado = await page.$('select[name="estado"]');
      if (selectEstado) {
        await page.select('select[name="estado"]', '14').catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        await page.select('select[name="cidade"]', '4565').catch(() => {});
      }
    } catch (e) {
      // Se os selects forem dinâmicos ou diferentes, prossegue sem travar
    }

    // 4. Dados de Documentação (RG e CPF)
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await preencherCampo('input[name="rg"], input[id*="rg" i]', rgLimpo);
      await page.select('select[name="estado_emissor"]', '14').catch(() => {});
    }

    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await preencherCampo('input[name="cpf"], input[id*="cpf" i]', cpfLimpo);

    // 5. Data de Nascimento (DD/MM/AAAA)
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo('input[name="dt_nascimento"], input[id*="nascimento" i]', dataFormatada);

    // 6. Submissão do Formulário de forma segura
    console.log('[PCPA] Submetendo consulta...');
    const botaoClicado = await page.evaluate(() => {
      const btn = document.querySelector('button.btn-primary, button[type="submit"], input[type="submit"]');
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

    // 7. Análise da página resultante
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
    console.error(`[PCPA] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCPA',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCPA] Navegador encerrado com sucesso.`);
    }
  }
}
