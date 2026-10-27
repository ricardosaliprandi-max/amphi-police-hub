import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(payload) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  let browser = null;

  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const docLimpo = String(dados.rg || dados.numero || dados.cpf || '').replace(/\D/g, '');

  let dataNasc = dados.dataNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
  }

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36');

    // 1. Carrega o portal sem interceptar nada para ver o comportamento nativo
    await page.goto(URL_ALVO, { waitUntil: 'networkidle2', timeout: 35000 });
    await page.waitForSelector('#formMaster', { timeout: 15000 });

    // 2. AUDITORIA: Estado inicial dos componentes PrimeFaces
    const estadoInicial = await page.evaluate(() => {
      return {
        viewState: document.getElementById('javax.faces.ViewState')?.value || 'AUSENTE',
        selectDocValor: document.getElementById('j_idt57_input')?.value,
        selectDocLabel: document.getElementById('j_idt57_label')?.innerText?.trim()
      };
    });

    // 3. Preenchimento via interação real do teclado (sem scripts artificiais)
    // Clica no componente visual do PrimeFaces para abrir a lista
    await page.click('#j_idt57_label');
    await new Promise(r => setTimeout(r, 500));
    
    // Seleciona o item "CARTEIRA DE IDENTIDADE (RG)" na lista suspensa do PrimeFaces
    const itemSelecionado = await page.evaluate(() => {
      const itens = Array.from(document.querySelectorAll('#j_idt57_items li'));
      const rgItem = itens.find(el => el.innerText.includes('IDENTIDADE') || el.innerText.includes('RG'));
      if (rgItem) {
        rgItem.click();
        return rgItem.innerText;
      }
      return null;
    });

    // Aguarda 1 segundo para o AJAX do onchange (#pngFiltro) estabilizar
    await new Promise(r => setTimeout(r, 1000));

    // Digita número
    await page.focus('#numero');
    await page.type('#numero', docLimpo, { delay: 30 });

    // Digita nome
    await page.focus('#nomeIndividuo');
    await page.type('#nomeIndividuo', nome, { delay: 20 });

    // Digita filiação se houver
    if (dados.nomeMae) {
      await page.focus('#nomeMae');
      await page.type('#nomeMae', dados.nomeMae.toUpperCase().trim(), { delay: 20 });
    }

    // Digita data de nascimento
    if (dataNasc) {
      await page.focus('#dtNascimento_input');
      await page.type('#dtNascimento_input', dataNasc, { delay: 30 });
      await page.keyboard.press('Tab');
    }

    await new Promise(r => setTimeout(r, 500));

    // 4. AUDITORIA PRÉ-SUBMIT: Os campos realmente retiveram o valor no DOM?
    const auditoriaPreSubmit = await page.evaluate(() => {
      return {
        docSelecionado: document.getElementById('j_idt57_input')?.value,
        docLabel: document.getElementById('j_idt57_label')?.innerText?.trim(),
        numeroNoInput: document.getElementById('numero')?.value,
        nomeNoInput: document.getElementById('nomeIndividuo')?.value,
        dataNoInput: document.getElementById('dtNascimento_input')?.value,
        viewState: document.getElementById('javax.faces.ViewState')?.value
      };
    });

    // 5. Intercepta requisições XHR do PrimeFaces para auditar o payload enviado ao servidor
    let payloadAjaxEnviado = null;
    page.on('request', req => {
      if (req.url().includes('pesquisaantecedentes.jsf') && req.method() === 'POST') {
        payloadAjaxEnviado = req.postData();
      }
    });

    // Clica no botão oficial
    await page.click('#btnPesquisar');

    // Aguarda 4 segundos de resposta da rede
    await new Promise(r => setTimeout(r, 4000));

    // 6. AUDITORIA PÓS-SUBMIT: O que aconteceu no DOM e nas variáveis de janela?
    const auditoriaPosSubmit = await page.evaluate(() => {
      const growl = document.querySelector('.ui-growl-message, .ui-messages-error')?.innerText?.trim() || null;
      const dlg101 = document.getElementById('j_idt101');
      const dlg115 = document.getElementById('j_idt115');

      return {
        growlDetectado: growl,
        modalPendenciaVisivel: dlg101 ? !dlg101.classList.contains('ui-overlay-hidden') : false,
        modalInconsistenteVisivel: dlg115 ? !dlg115.classList.contains('ui-overlay-hidden') : false,
        urlAtual: window.location.href,
        textoJanela: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300)
      };
    });

    return {
      sucesso: false,
      statusTexto: 'DIAGNÓSTICO CONCLUÍDO',
      diagnostico: {
        itemSelecionado,
        estadoInicial,
        auditoriaPreSubmit,
        payloadAjaxEnviado: payloadAjaxEnviado ? payloadAjaxEnviado.slice(0, 300) : 'NENHUM AJAX DISPARADO',
        auditoriaPosSubmit
      }
    };

  } catch (error) {
    return {
      sucesso: false,
      statusTexto: 'ERRO NO DIAGNÓSTICO',
      mensagem: error.message
    };
  } finally {
    if (browser) await browser.close();
  }
}
