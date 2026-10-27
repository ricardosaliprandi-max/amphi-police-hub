import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCCE(dados) {
  const URL_ALVO = 'https://sistemas.sspds.ce.gov.br/AtestadoAntecedentes/index.do';

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

    console.log(`[PCCE] Acessando portal oficial SSPDS-CE para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o carregamento inicial da página
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});

    // 1. Tratamento robusto de frameset / iframe
    let frameContext = page;
    try {
      await page.waitForSelector('frame, iframe', { timeout: 5000 }).catch(() => {});
      const frames = page.frames();
      const frameCorpo = frames.find(f => f.name() === 'frame_corpo' || f.url().includes('index.do') || f.url().includes('Atestado'));
      if (frameCorpo) {
        frameContext = frameCorpo;
      }
    } catch (e) {
      // Continua no contexto principal se não encontrar frame específico
    }

    // Aguarda o formulário carregar no contexto (página ou frame)
    await frameContext.waitForSelector('form[name="AtestadoForm"], form', { timeout: 12000 }).catch(() => {});

    // Função auxiliar segura para preencher campos por múltiplos seletores possíveis
    async function preencherCampo(seletores, valor) {
      if (!valor) return;
      for (const seletor of seletores) {
        try {
          const el = await frameContext.$(seletor);
          if (el) {
            await frameContext.focus(seletor);
            await frameContext.evaluate(s => document.querySelector(s).value = '', seletor);
            await frameContext.type(seletor, String(valor), { delay: 30 });
            return true;
          }
        } catch (e) {
          // Tenta o próximo seletor
        }
      }
      return false;
    }

    // 2. Preenchimento do RG
    const docLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    await preencherCampo(['input[name="numRg"]', '#numRg', 'input[id*="Rg" i]'], docLimpo);

    // 3. Preenchimento do Nome Completo
    const nomePreenchido = await preencherCampo(['input[name="nome"]', '#nome', 'input[id*="nome" i]'], dados.nome.toUpperCase().trim());
    if (!nomePreenchido) {
      throw new Error('Campo de nome não localizado no formulário da PCCE.');
    }

    // 4. Preenchimento da Data de Nascimento
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo(['input[name="dataNasc"]', '#dataNasc', 'input[id*="Nasc" i]'], dataFormatada);

    // 5. Preenchimento do Nome da Mãe
    const nomeMae = dados.nomeMae && dados.nomeMae.trim() !== '' ? dados.nomeMae.toUpperCase().trim() : '';
    if (nomeMae) {
      await preencherCampo(['input[name="mae"]', '#mae', 'input[id*="mae" i]'], nomeMae);
    }

    // Escuta de abertura de nova aba
    const newPagePromise = new Promise(resolve =>
      browser.once('targetcreated', target => resolve(target.page()))
    );

    // 6. Submissão do Formulário
    console.log('[PCCE] Clicando no botão Pesquisar...');
    const btnPesquisarSeletor = 'input[type="submit"][value="Pesquisar"], input[value*="Pesquisar" i], button[type="submit"]';
    
    const botaoClicado = await frameContext.evaluate((sel) => {
      const btn = document.querySelector(sel) || document.querySelector('input[type="submit"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, btnPesquisarSeletor);

    if (!botaoClicado) {
      await frameContext.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // 7. Corrida para capturar o resultado
    const raceResult = await Promise.race([
      newPagePromise.then(p => ({ tipo: 'NOVA_ABA', page: p })),
      new Promise(r => setTimeout(r, 4000)).then(() => ({ tipo: 'MESMA_PAGINA' }))
    ]);

    let targetPage = page;
    if (raceResult.tipo === 'NOVA_ABA' && raceResult.page) {
      targetPage = raceResult.page;
      await targetPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
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

    // Cenário B: Erros de inconsistência ou não localização
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
        mensagem: 'Registro da Carteira de Identidade não consta no banco de dados do Ceará ou exige atendimento presencial.'
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
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da Polícia Civil do Ceará.',
      rawSnippet: dadosResposta.texto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCCE] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCCE',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCCE] Navegador encerrado com sucesso.`);
    }
  }
}
