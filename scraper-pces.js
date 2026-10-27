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

    // Prepara escuta da segunda aba
    const newPagePromise = new Promise(resolve => 
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 7. Dispara emissão
    console.log('[PCES] Clicando no botão Emitir Atestado...');
    const btnSeletor = '#btnPesquisar, input[value*="Pesquisar" i], button[type="submit"]';
    await page.waitForSelector(btnSeletor, { timeout: 10000 }).catch(() => {});
    
    const botaoClicado = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, btnSeletor);

    if (!botaoClicado) {
      await page.keyboard.press('Enter');
    }

    // 8. Corrida: nova aba ou modal de erro
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      page.waitForSelector('.ui-dialog:not(.ui-overlay-hidden), .ui-growl-message, div[id*="idt"]', { timeout: 15000 })
        .then(() => ({ tipo: 'MODAL_ERRO' }))
        .catch(() => ({ tipo: 'TIMEOUT' }))
    ]);

    // Cenário A: Nova aba com Nada Consta
    if (raceResult.tipo === 'NOVA_ABA' && raceResult.page) {
      const atestadoPage = raceResult.page;
      await new Promise(r => setTimeout(r, 2000));
      const corpoTexto = await atestadoPage.evaluate(() => document.body.innerText || '');
      
      console.log('[PCES] Nova aba capturada com sucesso!');
      if (corpoTexto.includes('NADA CONSTA') || corpoTexto.includes('ATESTADO DE ANTECEDENTES')) {
        return {
          sucesso: true,
          hasRecords: false,
          statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
          mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
          rawSnippet: corpoTexto.slice(0, 300)
        };
      }
    }

    // Cenário B: Modais de Pendência ou Inconsistência
    const modalBloqueioVisivel = await page.$eval('#j_idt101', el => el && !el.classList.contains('ui-overlay-hidden')).catch(() => false);
    const modalInconsistenteVisivel = await page.$eval('#j_idt115', el => el && !el.classList.contains('ui-overlay-hidden')).catch(() => false);
    const growlTexto = await page.$eval('#growlGeral', el => el ? el.innerText : '').catch(() => '');

    if (modalBloqueioVisivel) {
      console.log('[PCES] Alerta de pendência cadastral.');
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'NÃO FOI POSSÍVEL EMITIR CERTIDÃO NEGATIVA',
        mensagem: 'Possível apontamento ou pendência na identificação criminal. O sistema oficial exige envio de documentos para atestado@pci.es.gov.br.'
      };
    }

    if (modalInconsistenteVisivel) {
      console.log('[PCES] Dados inconsistentes detectados.');
      return {
        sucesso: true,
        hasRecords: false,
        riskLevel: 'MEDIUM',
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: 'Dados informados divergem dos registros cadastrais do Instituto de Identificação do ES.'
      };
    }

    if (growlTexto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: growlTexto.trim()
      };
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'Não foi possível confirmar o atestado nem capturar mensagem de erro.'
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
