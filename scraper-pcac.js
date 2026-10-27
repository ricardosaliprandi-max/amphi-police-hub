import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCAC(dados) {
  // URL base oficial da emissão do Acre
  const URL_ALVO = 'https://idpol.ac.gov.br/services/AntecedentesCriminais/Emitir';

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Essencial para rodar de forma leve no limite de RAM do Render
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Intercepta e bloqueia recursos pesados para economizar RAM e CPU drasticamente
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCAC] Acessando portal oficial para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // 1. Preenchimento do RG (se houver)
    if (dados.rg || dados.numero) {
      await page.waitForSelector('#rg', { timeout: 10000 });
      await page.focus('#rg');
      const rgLimpo = String(dados.rg || dados.numero).replace(/\D/g, '');
      await page.keyboard.type(rgLimpo, { delay: 30 });
    }

    // 2. Preenchimento do Nome Completo (Obrigatório)
    await page.waitForSelector('#nome', { timeout: 10000 });
    await page.focus('#nome');
    await page.keyboard.type(dados.nome.toUpperCase().trim(), { delay: 30 });

    // 3. Preenchimento da Data de Nascimento (DD/MM/AAAA)
    await page.waitForSelector('#dataNascimento');
    await page.focus('#dataNascimento');
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await page.keyboard.type(dataFormatada, { delay: 40 });

    // 4. Preenchimento do CPF (Obrigatório)
    await page.waitForSelector('#cpf');
    await page.focus('#cpf');
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    let cpfComMascara = cpfLimpo;
    if (cpfLimpo.length === 11) {
      cpfComMascara = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    await page.keyboard.type(cpfComMascara, { delay: 30 });

    // 5. Preenchimento do Nome da Mãe (se houver)
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await page.waitForSelector('#mae');
      await page.focus('#mae');
      await page.keyboard.type(dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // Escuta de nova aba caso o PDF seja gerado diretamente
    const newPagePromise = new Promise(resolve => 
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 6. Clicar no botão Emitir
    console.log('[PCAC] Submetendo solicitação de emissão...');
    await page.waitForSelector('#btEmitir');
    await page.click('#btEmitir');

    // 7. Corrida para identificar resposta do sistema
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      page.waitForSelector('#modalResultados.in, #modalResultados[style*="display: block"]', { timeout: 15000 })
        .then(() => ({ tipo: 'MODAL_RESULTADOS' }))
        .catch(() => ({ tipo: 'TIMEOUT_MODAL' })),
      page.waitForFunction(() => {
        const msg = document.getElementById('MsgNadaConstaQuandoTemAntCrim');
        return msg && msg.style.display !== 'none' && msg.innerText.trim().length > 0;
      }, { timeout: 15000 })
        .then(() => ({ tipo: 'ALERTA_IMPEDIMENTO' }))
        .catch(() => ({ tipo: 'TIMEOUT_ALERTA' }))
    ]);

    // Cenário A: Nova aba com atestado ou documento emitido
    if (raceResult.tipo === 'NOVA_ABA' && raceResult.page) {
      const atestadoPage = raceResult.page;
      await new Promise(r => setTimeout(r, 2000));
      const corpoTexto = await atestadoPage.evaluate(() => document.body.innerText || '');

      console.log('[PCAC] Atestado emitido em nova aba com sucesso!');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes da Polícia Civil do Acre.',
        rawSnippet: corpoTexto.slice(0, 300)
      };
    }

    // Cenário B: Modal com resultados cadastrais retornados
    if (raceResult.tipo === 'MODAL_RESULTADOS') {
      console.log('[PCAC] Modal de resultados aberto.');
      const linhasTabela = await page.$$eval('#corpoTabelaModalResultados tr', rows => rows.length).catch(() => 0);

      if (linhasTabela > 0) {
        const primeiroBotaoAcao = await page.$('#corpoTabelaModalResultados tr:first-child a, #corpoTabelaModalResultados tr:first-child button');
        if (primeiroBotaoAcao) {
          await primeiroBotaoAcao.click();
          await new Promise(r => setTimeout(r, 2000));
        }

        return {
          sucesso: true,
          hasRecords: false,
          statusTexto: 'REGISTRO LOCALIZADO / CERTIDÃO DISPONÍVEL',
          mensagem: `Identificado registro correspondente na base da PCAC (${linhasTabela} resultado(s)).`,
          rawSnippet: 'Atestado emitido com base no cadastro civil do Acre.'
        };
      }
    }

    // Cenário C: Alerta de Impedimento / Pendência Criminal
    if (raceResult.tipo === 'ALERTA_IMPEDIMENTO') {
      const textoAlerta = await page.$eval('#MsgNadaConstaQuandoTemAntCrim', el => el.innerText).catch(() => '');
      console.log('[PCAC] Alerta de pendência ou impedimento:', textoAlerta);

      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'CERTIDÃO NEGATIVA NÃO EMITIDA',
        mensagem: textoAlerta || 'Constam pendências ou apontamentos que impedem a emissão online pelo portal do Acre.'
      };
    }

    // Cenário D: Validação de mensagens de erro gerais ou inputs inválidos
    const msgErroForm = await page.evaluate(() => {
      const erroEl = document.querySelector('.has-error .help-block:not([style*="display: none"])');
      return erroEl ? erroEl.innerText : null;
    });

    if (msgErroForm) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'DIVERGÊNCIA CADASTRAL',
        mensagem: msgErroForm
      };
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'Não foi possível confirmar a emissão no portal da Polícia Civil do Acre.'
    };

  } catch (error) {
    console.error(`[PCAC] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCAC] Navegador encerrado com sucesso.`);
    }
  }
}
