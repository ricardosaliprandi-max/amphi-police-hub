import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPB(dados) {
  const URL_ALVO = 'https://antecedentes.pc.pb.gov.br/EmitirAAC';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação rigorosa de TODAS as requisições POST para descobrir a API real
    let rotaApiCapturada = null;
    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'POST') {
        console.log(`[PCPB DEBUG REDE POST] URL: ${url}`);
        if (url.includes('api') || url.includes('antecedentes') || url.includes('emitir')) {
          rotaApiCapturada = url;
        }
        if (req.postData()) {
          console.log(`[PCPB DEBUG PAYLOAD]:`, req.postData());
        }
      }
    });

    console.log(`[PCPB DEBUG] Acessando portal da Paraíba...`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 });

    await page.waitForSelector('#form', { timeout: 10000 });

    // Normalização dos dados
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawRg = dados.rg || dados.numero || '';
    const rawName = dados.candidateName || dados.nome || '';
    const rawBirth = dados.candidateBirthDate || dados.dataNascimento || '';
    const rawMother = dados.motherName || dados.nomeMae || '';
    const rawFather = dados.fatherName || dados.nomePai || '';
    const rawOrgao = dados.orgaoExpedidor || 'SSP';

    const cpfLimpo = String(rawCpf).replace(/\D/g, '');
    const rgLimpo = String(rawRg).replace(/\D/g, '');
    let dataFormatada = rawBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }

    // Preenche os campos do formulário disparando eventos nativos
    console.log('[PCPB DEBUG] Preenchendo campos...');
    await page.evaluate((payload) => {
      const setVal = (sel, val) => {
        const el = document.querySelector(sel);
        if (el && val) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      };

      setVal('#rg', payload.rg);
      setVal('#orgaoExpedidor', payload.orgaoExpedidor);
      setVal('#nome', payload.nome);
      setVal('#dataNascimento', payload.dataNascimento);
      setVal('#cpf', payload.cpf);
      setVal('#mae', payload.mae);
      setVal('#pai', payload.pai);
    }, {
      rg: rgLimpo,
      orgaoExpedidor: rawOrgao.toUpperCase().trim(),
      nome: rawName.toUpperCase().trim(),
      dataNascimento: dataFormatada,
      cpf: cpfLimpo,
      mae: rawMother.toUpperCase().trim(),
      pai: rawFather.toUpperCase().trim()
    });

    await new Promise(r => setTimeout(r, 1000));

    // Clica no botão Emitir (#btEmitir) para forçar o site a disparar a requisição real
    console.log('[PCPB DEBUG] Clicando no botão #btEmitir...');
    await page.click('#btEmitir').catch(async () => {
      await page.evaluate(() => document.getElementById('btEmitir').click());
    });

    // Aguarda 8 segundos para a rede capturar a rota
    await new Promise(r => setTimeout(r, 8000));

    console.log(`[PCPB DEBUG] Rota capturada: ${rotaApiCapturada || 'NENHUMA ROTA POST CAPTURADA'}`);

    return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'AUDITORIA CONCLUÍDA',
        mensagem: `Rota da API capturada: ${rotaApiCapturada || 'Nenhuma'}`
    };

  } catch (error) {
    console.error(`[PCPB DEBUG] Erro:`, error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA AUDITORIA',
      mensagem: error.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
