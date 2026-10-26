import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCCE(dados) {
  const URL_ALVO = 'https://sistemas.sspds.ce.gov.br/AtestadoAntecedentes/index.do';

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[PCCE] Acessando portal oficial SSPDS-CE para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle2', timeout: 35000 });

    // 1. Tratamento de frameset (se carregou a casca ou direto o index.do)
    let frameContext = page;
    const frameCorpo = page.frames().find(f => f.name() === 'frame_corpo' || f.url().includes('index.do'));
    if (frameCorpo) {
      frameContext = frameCorpo;
    }

    // Aguarda o formulário do Atestado
    await frameContext.waitForSelector('form[name="AtestadoForm"]', { timeout: 15000 });

    // 2. Preenchimento do RG (sem dígito verificador)
    const docLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    await frameContext.waitForSelector('input[name="numRg"]');
    await frameContext.focus('input[name="numRg"]');
    await frameContext.type('input[name="numRg"]', docLimpo, { delay: 30 });

    // 3. Preenchimento do Nome Completo
    await frameContext.waitForSelector('input[name="nome"]');
    await frameContext.focus('input[name="nome"]');
    await frameContext.type('input[name="nome"]', dados.nome.toUpperCase().trim(), { delay: 30 });

    // 4. Preenchimento da Data de Nascimento (DD/MM/AAAA)
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await frameContext.waitForSelector('input[name="dataNasc"]');
    await frameContext.focus('input[name="dataNasc"]');
    await frameContext.type('input[name="dataNasc"]', dataFormatada, { delay: 40 });

    // 5. Preenchimento do Nome da Mãe
    const nomeMae = dados.nomeMae && dados.nomeMae.trim() !== '' ? dados.nomeMae.toUpperCase().trim() : '';
    await frameContext.waitForSelector('input[name="mae"]');
    await frameContext.focus('input[name="mae"]');
    await frameContext.type('input[name="mae"]', nomeMae, { delay: 30 });

    // Escuta de abertura de nova aba (caso a certidão seja aberta em popup/aba independente)
    const newPagePromise = new Promise(resolve =>
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 6. Submissão do Formulário
    console.log('[PCCE] Clicando no botão Pesquisar...');
    await Promise.all([
      frameContext.click('input[type="submit"][value="Pesquisar"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);

    // 7. Corrida para capturar o resultado (nova aba ou atualização do contexto)
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      new Promise(r => setTimeout(r, 4000)).then(() => ({ tipo: 'MESMA_PAGINA' }))
    ]);

    let targetPage = page;
    if (raceResult.tipo === 'NOVA_ABA' && raceResult.page) {
      targetPage = raceResult.page;
      await targetPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null);
    }

    // 8. Análise do conteúdo retornado
    const dadosResposta = await targetPage.evaluate(() => {
      const texto = document.body ? document.body.innerText : '';
      const errosDiv = document.getElementById('errors');
      const erroTexto = errosDiv ? errosDiv.innerText.trim() : '';
      return { texto, erroTexto };
    });

    const corpoTexto = dadosResposta.texto.toUpperCase();
    const erros = dadosResposta.erroTexto;

    // Cenário A: Certidão / Atestado emitido com sucesso
    if (corpoTexto.includes('NADA CONSTA') || corpoTexto.includes('ATESTADO DE ANTECEDENTES') || corpoTexto.includes('CERTIDÃO NEGATIVA')) {
      console.log('[PCCE] Atestado emitido com sucesso!');
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes criminais da SSPDS / Polícia Civil do Ceará.',
        rawSnippet: dadosResposta.texto.slice(0, 300)
      };
    }

    // Cenário B: Erros de inconsistência ou não localização na base do Ceará
    if (erros && erros.length > 0) {
      console.log('[PCCE] Mensagem de inconsistência detectada:', erros);
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'DADOS INCONSISTENTES / NÃO LOCALIZADO',
        mensagem: erros
      };
    }

    if (corpoTexto.includes('NÃO FOI POSSÍVEL') || corpoTexto.includes('DIRIGIR-SE') || corpoTexto.includes('NÃO CONSTA EM NOSSA BASE')) {
      console.log('[PCCE] Registro não localizado ou pendência cadastral.');
      return {
        sucesso: true,
        hasRecords: false,
        riskLevel: 'MEDIUM',
        statusTexto: 'REGISTRO NÃO LOCALIZADO NA BASE DO CE',
        mensagem: 'Registro da Carteira de Identidade não consta no banco de dados do Ceará ou exige atendimento presencial na CIHPB.'
      };
    }

    // Cenário C: Apontamento ou impedimento criminal
    if (corpoTexto.includes('PENDÊNCIA') || corpoTexto.includes('PROCESSO') || corpoTexto.includes('INQUÉRITO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'NÃO FOI POSSÍVEL EMITIR CERTIDÃO NEGATIVA',
        mensagem: 'Constam impedimentos ou registros processuais que impedem a emissão de certidão negativa automática na base da PCCE.'
      };
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'Não foi possível confirmar a emissão no portal da Polícia Civil do Ceará.'
    };

  } finally {
    await browser.close();
  }
}
