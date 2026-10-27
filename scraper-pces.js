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
    await page.waitForSelector('#formMaster', { timeout: 15000 }).catch(() => {});

    // 1. Seleção Correta do Tipo de Documento no PrimeFaces do ES
    let tipoDocValue = "1"; // Padrão RG
    const docTipoDesejado = (dados.tipoDocumento || 'RG').toUpperCase();
    if (docTipoDesejado.includes('CNH')) tipoDocValue = "7";
    if (docTipoDesejado.includes('CIN')) tipoDocValue = "12";

    await page.evaluate((val) => {
      const select = document.querySelector('#j_idt57_input');
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // Força atualização do widget PrimeFaces se disponível
        if (typeof widget_j_idt57 !== 'undefined' && widget_j_idt57.selectValue) {
          widget_j_idt57.selectValue(val);
        }
      }
    }, tipoDocValue);
    await new Promise(r => setTimeout(r, 1000));

    // 2. Preenchimento de Inputs com base nos IDs exatos do HTML
    // Número do Documento (#numero)
    const docLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (docLimpo) {
      await page.focus('#numero');
      await page.evaluate(() => document.querySelector('#numero').value = '');
      await page.type('#numero', docLimpo, { delay: 40 });
    }

    // Nome Completo (#nomeIndividuo)
    if (dados.nome) {
      await page.focus('#nomeIndividuo');
      await page.evaluate(() => document.querySelector('#nomeIndividuo').value = '');
      await page.type('#nomeIndividuo', dados.nome.toUpperCase().trim(), { delay: 30 });
    }

    // Nome do Pai (#nomePai) - Opcional
    if (dados.nomePai && dados.nomePai.trim() !== '' && !dados.nomePai.toUpperCase().includes('NÃO DECLARADO') && !dados.nomePai.toUpperCase().includes('NAO DECLARADO')) {
      await page.focus('#nomePai');
      await page.evaluate(() => document.querySelector('#nomePai').value = '');
      await page.type('#nomePai', dados.nomePai.toUpperCase().trim(), { delay: 30 });
    }

    // Nome da Mãe (#nomeMae)
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await page.focus('#nomeMae');
      await page.evaluate(() => document.querySelector('#nomeMae').value = '');
      await page.type('#nomeMae', dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }

    // Data de Nascimento (#dtNascimento_input) - Formato DD/MM/AAAA
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    if (dataFormatada) {
      await page.focus('#dtNascimento_input');
      await page.evaluate(() => document.querySelector('#dtNascimento_input').value = '');
      await page.type('#dtNascimento_input', dataFormatada, { delay: 40 });
    }

    // Escuta por nova aba (caso abra o atestado em PDF/pop-up)
    let novaAba = null;
    browser.once('targetcreated', async target => {
      try {
        const p = await target.page();
        if (p) novaAba = p;
      } catch (e) {}
    });

    // 3. Disparar a Pesquisa clicando no botão oficial #btnPesquisar
    console.log('[PCES] Disparando botão Emitir Atestado...');
    await page.click('#btnPesquisar').catch(async () => {
      // Fallback via evaluate se o clique direto falhar
      await page.evaluate(() => document.getElementById('btnPesquisar').click());
    });

    // Aguarda o processamento do AJAX e renderização de modais / nova aba
    await new Promise(r => setTimeout(r, 6000));

    // Se abriu nova aba com o resultado
    if (novaAba) {
      try {
        await new Promise(r => setTimeout(r, 2000));
        const textoAba = await novaAba.evaluate(() => document.body.innerText || '');
        if (textoAba.includes('NADA CONSTA') || textoAba.includes('ATESTADO DE ANTECEDENTES') || textoAba.includes('CERTIDÃO')) {
          return {
            sucesso: true,
            hasRecords: false,
            statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
            mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
            rawSnippet: textoAba.slice(0, 300)
          };
        }
      } catch (e) {}
    }

    // 4. Verificação de Modais de Bloqueio ou Erro baseados nos IDs exatos do HTML
    const resultadoAnalise = await page.evaluate(() => {
      // Verifica growl de mensagens do PrimeFaces
      const growl = document.querySelector('#growlGeral, .ui-growl-message, .ui-messages-error-summary');
      if (growl && growl.innerText.trim() !== '') {
        return { tipo: 'GROWL', texto: growl.innerText.trim() };
      }

      // Verifica diálogo de pendência cadastral (#j_idt101)
      const dlgPendencia = document.querySelector('#j_idt101');
      if (dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden')) {
        return { tipo: 'PENDENCIA', texto: 'Encaminhe cópia de documento para atestado@pci.es.gov.br' };
      }

      // Verifica diálogo de dados inconsistentes (#j_idt115)
      const dlgInconsistente = document.querySelector('#j_idt115');
      if (dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden')) {
        return { tipo: 'INCONSISTENTE', texto: 'Dados inconsistentes com o Instituto de Identificação do ES.' };
      }

      const corpo = document.body.innerText || '';
      return { tipo: 'CORPO', texto: corpo };
    });

    if (resultadoAnalise.tipo === 'PENDENCIA') {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'PENDÊNCIA CADASTRAL / APONTAMENTO',
        mensagem: resultadoAnalise.texto
      };
    }

    if (resultadoAnalise.tipo === 'INCONSISTENTE') {
      return {
        sucesso: true,
        hasRecords: false,
        riskLevel: 'MEDIUM',
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: resultadoAnalise.texto
      };
    }

    if (resultadoAnalise.tipo === 'GROWL' && resultadoAnalise.texto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: resultadoAnalise.texto
      };
    }

    const textoTotal = resultadoAnalise.texto.toUpperCase();

    if (textoTotal.includes('NADA CONSTA') || textoTotal.includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
        rawSnippet: resultadoAnalise.texto.slice(0, 300)
      };
    }

    if (textoTotal.includes('EXISTEM REGISTROS') || textoTotal.includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCES.'
      };
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'A automação disparou a consulta, mas o portal não retornou o atestado nem exibiu modais mapeados.',
      rawSnippet: resultadoAnalise.texto.replace(/\s+/g, ' ').slice(0, 300)
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
