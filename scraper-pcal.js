import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCAL(dados) {
  const URL_ALVO = 'https://idseg.institutodeidentificacao.al.gov.br/Vsoft.iDSPS.Agendamento/AntecedentesCriminais/Emitir';

  const browser = await puppeteer.launch({
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

    console.log(`[PCAL] Acessando portal oficial para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // 1. Documento de Identificação (RG / CIN)
    if (dados.rg || dados.numero) {
      await page.waitForSelector('#rg', { timeout: 10000 });
      await page.focus('#rg');
      const docLimpo = String(dados.rg || dados.numero).replace(/\D/g, '');
      await page.keyboard.type(docLimpo, { delay: 30 });
    }

    // 2. Órgão Expedidor (default: SSP)
    if (dados.orgaoExpedidor || dados.expedidor) {
      await page.waitForSelector('#orgaoExpedidor', { timeout: 10000 });
      await page.focus('#orgaoExpedidor');
      await page.keyboard.type(String(dados.orgaoExpedidor || dados.expedidor).toUpperCase().trim(), { delay: 30 });
    } else {
      const inputOrgao = await page.$('#orgaoExpedidor');
      if (inputOrgao) {
        await page.focus('#orgaoExpedidor');
        await page.keyboard.type('SSP', { delay: 30 });
      }
    }

    // 3. Nome Completo (Obrigatório)
    await page.waitForSelector('#nome', { timeout: 10000 });
    await page.focus('#nome');
    await page.keyboard.type(dados.nome.toUpperCase().trim(), { delay: 30 });

    // 4. Data de Nascimento (DD/MM/AAAA)
    await page.waitForSelector('#dataNascimento');
    await page.focus('#dataNascimento');
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await page.keyboard.type(dataFormatada, { delay: 40 });

    // 5. CPF (Obrigatório)
    await page.waitForSelector('#cpf');
    await page.focus('#cpf');
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    let cpfComMascara = cpfLimpo;
    if (cpfLimpo.length === 11) {
      cpfComMascara = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    await page.keyboard.type(cpfComMascara, { delay: 30 });

    // 6. Nome da Mãe
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await page.waitForSelector('#mae');
      await page.focus('#mae');
      await page.keyboard.type(dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // 7. Nome do Pai (opcional)
    if (dados.nomePai && dados.nomePai.trim() !== '' && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      const inputPai = await page.$('#pai');
      if (inputPai) {
        await page.focus('#pai');
        await page.keyboard.type(dados.nomePai.toUpperCase().trim(), { delay: 30 });
      }
    }

    // Escuta de abertura de nova aba
    const newPagePromise = new Promise(resolve =>
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 8. Disparo do Formulário
    console.log('[PCAL] Clicando no botão Emitir...');
    await page.waitForSelector('#btEmitir');
    await page.click('#btEmitir');

    // 9. Corrida de Resolução do Portal
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      page.waitForSelector('#modalResultados.show, #modalResultados[style*="display: block"]', { timeout: 15000 })
        .then(() => ({ tipo: 'MODAL_RESULTADOS' }))
        .catch(() => ({ tipo: 'TIMEOUT_MODAL' })),
      page.waitForFunction(() => {
        const msg = document.getElementById('MsgNadaConstaQuandoTemAntCrim');
        return msg && msg.style.display !== 'none' && msg.innerText.trim().length > 0;
      }, { timeout: 15000 })
        .then(() => ({ tipo: 'ALERTA_IMPEDIMENTO' }))
        .catch(() => ({ tipo: 'TIMEOUT_ALERTA' }))
    ]);

    // Cenário A: Nova aba com Atestado
    if (raceResult.tipo === 'NOVA_ABA' && raceResult.page) {
      const atestadoPage = raceResult.page;
      await new Promise(r => setTimeout(r, 2000));
      const corpoTexto = await atestadoPage.evaluate(() => document.body.innerText || '');

      console.log('[PCAL] Certidão emitida com sucesso!');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes da Polícia Civil de Alagoas.',
        rawSnippet: corpoTexto.slice(0, 300)
      };
    }

    // Cenário B: Modal com registros encontrados
    if (raceResult.tipo === 'MODAL_RESULTADOS') {
      console.log('[PCAL] Modal de resultados retornado.');
      const linhasTabela = await page.$$eval('#corpoTabelaModalResultados tr', rows => rows.length).catch(() => 0);

      if (linhasTabela > 0) {
        const btnDownload = await page.$('#corpoTabelaModalResultados tr:first-child a, #corpoTabelaModalResultados tr:first-child button');
        if (btnDownload) {
          await btnDownload.click();
          await new Promise(r => setTimeout(r, 2000));
        }

        return {
          sucesso: true,
          hasRecords: false,
          statusTexto: 'REGISTRO LOCALIZADO / CERTIDÃO DISPONÍVEL',
          mensagem: `Identificado registro cadastral na base civil de Alagoas (${linhasTabela} resultado(s)).`,
          rawSnippet: 'Atestado emitido com base no Instituto de Identificação de AL.'
        };
      }
    }

    // Cenário C: Alerta de Impedimento / Pendência Criminal
    if (raceResult.tipo === 'ALERTA_IMPEDIMENTO') {
      const textoAlerta = await page.$eval('#MsgNadaConstaQuandoTemAntCrim', el => el.innerText).catch(() => '');
      console.log('[PCAL] Apontamento criminal detectado:', textoAlerta);

      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'CERTIDÃO NEGATIVA NÃO EMITIDA',
        mensagem: textoAlerta || 'Constam apontamentos criminais ou pendências que impedem a emissão automática do Nada Consta no estado de Alagoas.'
      };
    }

    // Cenário D: Erros de validação nos campos do formulário
    const msgErroForm = await page.evaluate(() => {
      const erroEl = document.querySelector('.has-error .help-block:not([style*="display: none"]), .invalid-feedback:not([style*="display: none"])');
      return erroEl ? erroEl.innerText : null;
    });

    if (msgErroForm) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: msgErroForm
      };
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'Não foi possível confirmar a emissão no portal da Polícia Civil de Alagoas.'
    };

  } catch (error) {
    console.error(`[PCAL] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCAL] Navegador encerrado com sucesso.`);
    }
  }
}
