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

    // 1. Tipo de documento no PrimeFaces (1 = RG, 7 = CNH, 12 = CIN)
    let tipoDocValue = "1";
    if (dados.tipoDocumento === 'CNH') tipoDocValue = "7";
    if (dados.tipoDocumento === 'CIN') tipoDocValue = "12";

    await page.waitForSelector('#j_idt57_input', { timeout: 10000 });
    await page.select('#j_idt57_input', tipoDocValue);
    
    await page.evaluate(() => {
      const select = document.getElementById('j_idt57_input');
      if (select) select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 600));

    // 2. Número do Documento
    await page.waitForSelector('#numero');
    await page.focus('#numero');
    const docLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    await page.keyboard.type(docLimpo, { delay: 40 });

    // 3. Nome Completo
    await page.waitForSelector('#nomeIndividuo');
    await page.focus('#nomeIndividuo');
    await page.keyboard.type(dados.nome.toUpperCase().trim(), { delay: 30 });

    // 4. Nome do Pai (opcional)
    if (dados.nomePai && dados.nomePai.trim() !== '' && dados.nomePai.toUpperCase() !== 'NÃO DECLARADO' && dados.nomePai.toUpperCase() !== 'NAO DECLARADO') {
      await page.waitForSelector('#nomePai');
      await page.focus('#nomePai');
      await page.keyboard.type(dados.nomePai.toUpperCase().trim(), { delay: 30 });
    }

    // 5. Nome da Mãe
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await page.waitForSelector('#nomeMae');
      await page.focus('#nomeMae');
      await page.keyboard.type(dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // 6. Data de Nascimento (formato DD/MM/AAAA)
    await page.waitForSelector('#dtNascimento_input');
    await page.focus('#dtNascimento_input');
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await page.keyboard.type(dataFormatada, { delay: 40 });

    // Prepara escuta da segunda aba
    const newPagePromise = new Promise(resolve => 
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 7. Dispara emissão
    console.log('[PCES] Clicando no botão Emitir Atestado...');
    await page.waitForSelector('#btnPesquisar');
    await page.click('#btnPesquisar');

    // 8. Corrida: nova aba ou modal de erro
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      page.waitForSelector('#j_idt101:not(.ui-overlay-hidden), #j_idt115:not(.ui-overlay-hidden), .ui-growl-message', { timeout: 15000 })
        .then(() => ({ tipo: 'MODAL_ERRO' }))
        .catch(() => ({ tipo: 'TIMEOUT' }))
    ]);

    // Cenário A: Nova aba com Nada Consta
    if (raceResult.tipo === 'NOVA_ABA' && raceResult.page) {
      const atestadoPage = raceResult.page;
      await new Promise(r => setTimeout(r, 2000));
      const corpoTexto = await atestadoPage.evaluate(() => document.body.innerText);
      
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
    const modalBloqueioVisivel = await page.$eval('#j_idt101', el => !el.classList.contains('ui-overlay-hidden')).catch(() => false);
    const modalInconsistenteVisivel = await page.$eval('#j_idt115', el => !el.classList.contains('ui-overlay-hidden')).catch(() => false);
    const growlTexto = await page.$eval('#growlGeral', el => el.innerText).catch(() => '');

    if (modalBloqueioVisivel) {
      console.log('[PCES] Alerta de pendência cadastral (#j_idt101).');
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'NÃO FOI POSSÍVEL EMITIR CERTIDÃO NEGATIVA',
        mensagem: 'Possível apontamento ou pendência na identificação criminal. O sistema oficial exige envio de documentos para atestado@pci.es.gov.br.'
      };
    }

    if (modalInconsistenteVisivel) {
      console.log('[PCES] Dados inconsistentes detectados (#j_idt115).');
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
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: growlTexto.trim()
      };
    }

    return {
      sucesso: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'Não foi possível confirmar o atestado nem capturar mensagem de erro.'
    };

  } catch (error) {
    console.error(`[PCES] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCES] Navegador encerrado com sucesso.`);
    }
  }
}
