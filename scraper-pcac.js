import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCAC(dados) {
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
      '--single-process', // Essencial para rodar no limite de RAM do Render
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Intercepta e bloqueia recursos pesados para economizar RAM
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

    // Aguarda qualquer input carregar para garantir que a página renderizou o DOM
    await page.waitForSelector('input', { timeout: 15000 }).catch(() => {});

    // Função auxiliar segura para preencher campos por múltiplos seletores possíveis
    async function preencherCampo(seletores, valor) {
      if (!valor) return;
      for (const seletor of seletores) {
        try {
          const el = await page.$(seletor);
          if (el) {
            await page.focus(seletor);
            await page.evaluate(s => document.querySelector(s).value = '', seletor); // Limpa o campo
            await page.type(seletor, String(valor), { delay: 25 });
            return true;
          }
        } catch (e) {
          // Tenta o próximo seletor
        }
      }
      return false;
    }

    // 1. Preenchimento do RG (opcional / flexível)
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await preencherCampo(['#rg', 'input[name*="rg" i]', 'input[id*="rg" i]'], rgLimpo);
    }

    // 2. Preenchimento do Nome Completo (Obrigatório)
    const nomePreenchido = await preencherCampo(['#nome', 'input[name*="nome" i]', 'input[id*="nome" i]'], dados.nome.toUpperCase().trim());
    if (!nomePreenchido) {
      throw-new Error('Campo de nome não localizado no formulário da PCAC.');
    }

    // 3. Data de Nascimento
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo(['#dataNascimento', 'input[name*="nascimento" i]', 'input[id*="nascimento" i]'], dataFormatada);

    // 4. CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    let cpfComMascara = cpfLimpo;
    if (cpfLimpo.length === 11) {
      cpfComMascara = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    await preencherCampo(['#cpf', 'input[name*="cpf" i]', 'input[id*="cpf" i]'], cpfComMascara);

    // 5. Nome da Mãe
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await preencherCampo(['#mae', 'input[name*="mae" i]', 'input[id*="mae" i]'], dados.nomeMae.toUpperCase().trim());
    }

    // Escuta de nova aba caso o PDF seja gerado diretamente
    const newPagePromise = new Promise(resolve => 
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 6. Clicar no botão Emitir (procura por ID ou seletores genéricos de botão de submissão)
    console.log('[PCAC] Submetendo solicitação de emissão...');
    const btnEmitirSeletor = '#btEmitir, button[type="submit"], input[type="submit"], button:not([type])';
    await page.waitForSelector(btnEmitirSeletor, { timeout: 10000 }).catch(() => {});
    
    const botaoClicado = await page.evaluate((sel) => {
      const btns = Array.from(document.querySelectorAll(sel));
      const alvo = btns.find(b => b.innerText.toLowerCase().includes('emitir') || b.id.includes('Emitir') || b.type === 'submit');
      if (alvo) {
        alvo.click();
        return true;
      }
      return false;
    }, btnEmitirSeletor);

    if (!botaoClicado) {
      await page.keyboard.press('Enter');
    }

    // 7. Corrida para identificar resposta do sistema
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      page.waitForSelector('#modalResultados.in, #modalResultados[style*="display: block"]', { timeout: 12000 })
        .then(() => ({ tipo: 'MODAL_RESULTADOS' }))
        .catch(() => ({ tipo: 'TIMEOUT_MODAL' })),
      page.waitForFunction(() => {
        const msg = document.getElementById('MsgNadaConstaQuandoTemAntCrim');
        return msg && msg.style.display !== 'none' && msg.innerText.trim().length > 0;
      }, { timeout: 12000 })
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

      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'REGISTRO LOCALIZADO / CERTIDÃO DISPONÍVEL',
        mensagem: `Identificado registro correspondente na base da PCAC (${linhasTabela} resultado(s)).`,
        rawSnippet: 'Atestado emitido com base no cadastro civil do Acre.'
      };
    }

    // Cenário C: Alerta de Impedimento / Pendência Criminal
    if (raceResult.tipo === 'ALERTA_IMPEDIMENTO') {
      const textoAlerta = await page.$eval('#MsgNadaConstaQuandoTemAntCrim', el => el.innerText).catch(() => '');
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'CERTIDÃO NEGATIVA NÃO EMITIDA',
        mensagem: textoAlerta || 'Constam pendências ou apontamentos que impedem a emissão online pelo portal do Acre.'
      };
    }

    // Cenário D: Captura de texto geral da página caso tenha emitido diretamente
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');
    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil do Acre.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCAC.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCAC] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCAC',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCAC] Navegador encerrado com sucesso.`);
    }
  }
}
