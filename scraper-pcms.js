import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMS(dados) {
  const URL_ALVO = 'https://antecedentes.sejusp.ms.gov.br/pages/MasterPages/IUPrincipal.aspx';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação de rede para logar o que a API responde de verdade
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('Atestado') || url.includes('api') || url.includes('Emitir') || url.includes('Consultar')) {
        console.log(`[PCMS NETWORK] URL: ${url} | Status: ${res.status()}`);
        try {
          const txt = await res.text();
          console.log(`[PCMS NETWORK BODY]:`, txt.slice(0, 400));
        } catch (e) {}
      }
    });

    console.log(`[PCMS DEBUG] Acessando portal MS...`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle0', timeout: 40000 });

    // Clica em Solicitar
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const sol = links.find(l => l.innerText.toLowerCase().includes('solicitar'));
      if (sol) sol.click();
    });

    // Aguarda o frame carregar
    let frameAtestado = null;
    let tentativas = 0;
    while (!frameAtestado && tentativas < 20) {
      const frames = page.frames();
      frameAtestado = frames.find(f => f.url().includes('IUAtestado.aspx'));
      if (!frameAtestado) {
        await new Promise(r => setTimeout(r, 500));
        tentativas++;
      }
    }

    if (!frameAtestado) throw new Error('IFrame IUAtestado.aspx não carregou.');
    await frameAtestado.waitForSelector('#txtNome', { timeout: 15000 });

    // Dados
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawRg = dados.rg || dados.numero || '';
    const rawName = dados.candidateName || dados.nome || '';
    const rawBirth = dados.candidateBirthDate || dados.dataNascimento || '';
    const rawMother = dados.motherName || dados.nomeMae || '';
    const rawFather = dados.fatherName || dados.nomePai || '';
    const cpfLimpo = String(rawCpf).replace(/\D/g, '');
    const rgLimpo = String(rawRg).replace(/\D/g, '');
    let dataFormatada = rawBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }

    // Preenche
    await frameAtestado.evaluate((payload) => {
      const setField = (sel, val) => {
        const el = document.querySelector(sel);
        if (el && val) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      };
      setField('#txtNome', payload.nome);
      setField('#txtMae', payload.mae);
      setField('#txtPai', payload.pai);
      setField('#txtDataNascimento', payload.dataNascimento);
      
      const selectDoc = document.querySelector('#cmbTipoDocumento');
      if (selectDoc) {
        selectDoc.value = payload.cpf ? 'CPF' : 'RG';
        selectDoc.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setField('#txtNumeroDocumento', payload.cpf || payload.rg);
    }, {
      nome: rawName.toUpperCase().trim(),
      mae: rawMother.toUpperCase().trim(),
      pai: rawFather.toUpperCase().trim(),
      dataNascimento: dataFormatada,
      cpf: cpfLimpo,
      rg: rgLimpo
    });

    await new Promise(r => setTimeout(r, 1000));

    // Clica no botão de emitir/pesquisar
    console.log('[PCMS DEBUG] Clicando no botão de submissão...');
    await frameAtestado.evaluate(() => {
      const botoes = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn'));
      const btn = botoes.find(b => {
        const txt = (b.innerText || b.value || '').toLowerCase();
        return txt.includes('pesquisar') || txt.includes('emitir') || txt.includes('consultar') || txt.includes('solicitar');
      });
      if (btn) btn.click();
      else if (botoes.length > 0) botoes[0].click();
    });

    // 🔍 INVESTIGAÇÃO CRUCIAL: Aguarda 10 segundos para o servidor responder e capta a tela inteira do iframe
    console.log('[PCMS DEBUG] Aguardando processamento da resposta da PCMS (10s)...');
    await new Promise(r => setTimeout(r, 10000));

    const htmlOuTextoFinal = await frameAtestado.evaluate(() => {
      // Pega todo o texto visível e também mensagens de erro do validador (ex: spans com erro, sweetalert)
      const elementosErro = Array.from(document.querySelectorAll('.error, .text-danger, .sweet-alert, .toastr, .alert'));
      const msgsErro = elementosErro.map(el => el.innerText).join(' | ');
      return {
        msgsErro,
        corpoTexto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1000)
      };
    });

    console.log('[PCMS DEBUG RESULTADO NA TELA]:', htmlOuTextoFinal);

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'DIAGNÓSTICO CONCLUÍDO',
      mensagem: `Texto capturado na tela: ${htmlOuTextoFinal.corpoTexto.slice(0, 150)}`
    };

  } catch (error) {
    console.error(`[PCMS DEBUG] Erro:`, error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NO DIAGNÓSTICO',
      mensagem: error.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
