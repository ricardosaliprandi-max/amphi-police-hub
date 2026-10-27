import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(dados) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  
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
    
    console.log(`[PCES] Acessando portal oficial para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário carregar
    await page.waitForSelector('input, select', { timeout: 15000 }).catch(() => {});

    // 1. Tipo de documento no PrimeFaces (1 = RG, 7 = CNH, 12 = CIN)
    let tipoDocValue = "1";
    if (dados.tipoDocumento === 'CNH') tipoDocValue = "7";
    if (dados.tipoDocumento === 'CIN') tipoDocValue = "12";

    const selectDocSeletor = '#j_idt57_input, select[id*="idt57" i], select';
    await page.waitForSelector(selectDocSeletor, { timeout: 10000 }).catch(() => {});
    await page.select(selectDocSeletor, tipoDocValue).catch(() => {});
    
    await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      if (selects.length > 0) {
        selects[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 600));

    // Função auxiliar segura para preencher inputs
    async function preencherInput(seletorPadrao, seletoresAlternativos, valor, delay = 30) {
      if (!valor) return;
      const todos = [seletorPadrao, ...seletoresAlternativos];
      for (const sel of todos) {
        try {
          const el = await page.$(sel);
          if (el) {
            await page.focus(sel);
            await page.evaluate(s => document.querySelector(s).value = '', sel);
            await page.type(sel, String(valor), { delay });
            return true;
          }
        } catch (e) {
          // Tenta o próximo
        }
      }
      return false;
    }

    // 2. Número do Documento
    const docLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    await preencherInput('#numero', ['input[name*="numero" i]', 'input[id*="numero" i]'], docLimpo, 40);

    // 3. Nome Completo
    await preencherInput('#nomeIndividuo', ['input[name*="nome" i]', 'input[id*="nome" i]'], dados.nome.toUpperCase().trim(), 30);

    // 4. Nome do Pai (opcional)
    if (dados.nomePai && dados.nomePai.trim() !== '' && dados.nomePai.toUpperCase() !== 'NÃO DECLARADO' && dados.nomePai.toUpperCase() !== 'NAO DECLARADO') {
      await preencherInput('#nomePai', ['input[name*="Pai" i]', 'input[id*="Pai" i]'], dados.nomePai.toUpperCase().trim(), 30);
    }

    // 5. Nome da Mãe
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await preencherInput('#nomeMae', ['input[name*="Mae" i]', 'input[id*="Mae" i]'], dados.nomeMae.toUpperCase().trim(), 30);
    }

    // 6. Data de Nascimento (formato DD/MM/AAAA)
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherInput('#dtNascimento_input', ['input[name*="Nascimento" i]', 'input[id*="Nascimento" i]'], dataFormatada, 40);

    // Prepara escuta de nova aba (pop-up de certidão)
    let novaAba = null;
    browser.once('targetcreated', async target => {
      try {
        const p = await target.page();
        if (p) novaAba = p;
      } catch (e) {}
    });

    // 7. Dispara emissão
    console.log('[PCES] Clicando no botão Emitir Atestado...');
    const btnSeletor = '#btnPesquisar, input[value*="Pesquisar" i], button[type="submit"]';
    await page.waitForSelector(btnSeletor, { timeout: 10000 }).catch(() => {});
    
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, btnSeletor);

    // Aguarda o processamento do PrimeFaces / Ajax / Navegação
    await new Promise(r => setTimeout(r, 5000));

    // Verifica se abriu nova aba com o documento
    if (novaAba) {
      try {
        await novaAba.waitForLoadState ? await novaAba.waitForLoadState('domcontentloaded') : await new Promise(r => setTimeout(r, 2000));
        const textoAba = await novaAba.evaluate(() => document.body.innerText || '');
        if (textoAba.includes('NADA CONSTA') || textoAba.includes('ATESTADO DE ANTECEDENTES')) {
          return {
            sucesso: true,
            hasRecords: false,
            statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
            mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
            rawSnippet: textoAba.slice(0, 300)
          };
        }
      } catch (err) {}
    }

    // Lê o conteúdo da página principal após a submissão
    const corpoTexto = await page.evaluate(() => document.body.innerText || '');
    const growlTexto = await page.evaluate(() => {
      const growl = document.querySelector('.ui-growl-message, .ui-messages-error, .ui-messages-warn');
      return growl ? growl.innerText : '';
    });

    if (growlTexto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: growlTexto.trim()
      };
    }

    if (corpoTexto.toUpperCase().includes('NADA CONSTA') || corpoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
        rawSnippet: corpoTexto.slice(0, 300)
      };
    }

    if (corpoTexto.toUpperCase().includes('EXISTEM REGISTROS') || corpoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCES.'
      };
    }

    // Retorna um snippet do texto capturado para diagnóstico imediato se cair aqui novamente
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'A página respondeu, mas os termos de certidão não foram identificados.',
      rawSnippet: corpoTexto.replace(/\s+/g, ' ').slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCES] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCES',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCES] Navegador encerrado com sucesso.`);
    }
  }
}
