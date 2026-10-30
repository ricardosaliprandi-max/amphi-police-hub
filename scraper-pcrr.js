import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRR(dados) {
  const URL_ALVO = 'https://www.idnetbrasil.rr.gov.br/AtestadoWeb/pages/MasterPages/IUPrincipal.aspx';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação rigorosa de rede para auditar a requisição e o PDF/resposta
    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'POST' || req.method() === 'GET') {
        console.log(`[PCRR DEBUG REDE] Método: ${req.method()} | URL: ${url}`);
      }
    });

    page.on('response', async res => {
      const url = res.url();
      const contentType = res.headers()['content-type'] || '';
      if (contentType.includes('application/pdf') || url.includes('Atestado') || url.includes('Relatorio')) {
        console.log(`[PCRR DEBUG RESPOSTA PDF/RELATÓRIO] URL: ${url} | Content-Type: ${contentType}`);
      }
    });

    console.log(`[PCRR DEBUG] Acessando portal de Roraima...`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle0', timeout: 40000 });

    // Clica no menu "Solicitar" conforme mapeado no HTML do side-menu
    console.log('[PCRR DEBUG] Clicando no menu "Solicitar"...');
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const sol = links.find(l => l.innerText.toLowerCase().includes('solicitar'));
      if (sol) sol.click();
    });

    // Aguarda o iframe interno carregar (IUAtestado.aspx, igual ao MS)
    console.log('[PCRR DEBUG] Aguardando carregamento do iframe de atestado...');
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

    if (!frameAtestado) {
      throw new Error('O iframe de solicitação (IUAtestado.aspx) não foi carregado na PCRR.');
    }

    await frameAtestado.waitForSelector('#txtNome', { timeout: 15000 });

    // Normalização dos dados
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawRg = dados.rg || dados.numero || '';
    const rawName = dados.candidateName || dados.nome || '';
    const rawBirth = dados.candidateBirthDate || dados.dataNascimento || '';
    const rawMother = dados.motherName || dados.nomeMae || dados.filiacao1 || '';
    const rawFather = dados.fatherName || dados.nomePai || dados.filiacao2 || '';
    const rawUfRg = dados.ufRg || 'RR';

    const cpfLimpo = String(rawCpf).replace(/\D/g, '');
    const rgLimpo = String(rawRg).replace(/\D/g, '');
    let dataFormatada = rawBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }

    // Preenche os campos dentro do iframe
    console.log('[PCRR DEBUG] Preenchendo formulário interno...');
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

      // Identidade civil RR (caso exista o combo igual ao MS)
      const selectIdentidade = document.querySelector('#cmbIdentidadeMS') || document.querySelector('#cmbIdentidadeRR');
      if (selectIdentidade) {
        selectIdentidade.value = payload.ufRg === 'RR' ? 'S' : 'N';
        selectIdentidade.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setField('#txtNome', payload.nome);
      setField('#txtMae', payload.filiacao1);
      setField('#txtPai', payload.filiacao2);
      setField('#txtDataNascimento', payload.dataNascimento);

      const selectDoc = document.querySelector('#cmbTipoDocumento');
      if (selectDoc) {
        selectDoc.value = payload.cpf ? 'CPF' : 'RG';
        selectDoc.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setField('#txtNumeroDocumento', payload.cpf || payload.rg);
    }, {
      nome: rawName.toUpperCase().trim(),
      filiacao1: rawMother.toUpperCase().trim(),
      filiacao2: rawFather.toUpperCase().trim(),
      dataNascimento: dataFormatada,
      cpf: cpfLimpo,
      rg: rgLimpo,
      ufRg: rawUfRg.toUpperCase().trim()
    });

    await new Promise(r => setTimeout(r, 1500));

    // Clica no botão de submissão (Gerar Certidão / Pesquisar)
    console.log('[PCRR DEBUG] Acionando botão de submissão...');
    await frameAtestado.evaluate(() => {
      const botoes = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn, a'));
      const btn = botoes.find(b => {
        const txt = (b.innerText || b.value || '').toLowerCase();
        return txt.includes('gerar') || txt.includes('pesquisar') || txt.includes('emitir');
      });
      if (btn) btn.click();
    });

    // Aguarda o processamento e a resposta do PDF
    console.log('[PCRR DEBUG] Aguardando processamento da resposta (12s)...');
    await new Promise(r => setTimeout(r, 12000));

    const corpoTexto = await frameAtestado.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 400) : '');
    console.log('[PCRR DEBUG TEXTO TELA]:', corpoTexto);

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'AUDITORIA PCRR CONCLUÍDA',
      mensagem: `Texto capturado na tela: ${corpoTexto.slice(0, 150)}`
    };

  } catch (error) {
    console.error(`[PCRR DEBUG] Erro:`, error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA AUDITORIA PCRR',
      mensagem: error.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
