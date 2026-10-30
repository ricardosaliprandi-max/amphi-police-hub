import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  const URL_ALVO = 'https://sinf2.policiacivil.rn.gov.br/siscert/Home/index';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Interceptação rigorosa de TODAS as requisições de rede para auditoria
    page.on('request', req => {
      const url = req.url();
      console.log(`[PCRN DEBUG REDE] Método: ${req.method()} | URL: ${url}`);
      if (req.method() === 'POST' || req.method() === 'GET') {
        const postData = req.postData();
        if (postData) {
          console.log(`[PCRN DEBUG PAYLOAD]:`, postData);
        }
      }
    });

    // Interceptação de respostas para inspecionar o retorno (ex: PDF ou JSON)
    page.on('response', async res => {
      const url = res.url();
      const contentType = res.headers()['content-type'] || '';
      if (url.includes('gerarDeclaracaoEmPDF') || contentType.includes('application/pdf') || contentType.includes('json')) {
        console.log(`[PCRN DEBUG RESPOSTA] URL: ${url} | Content-Type: ${contentType} | Status: ${res.status()}`);
      }
    });

    console.log(`[PCRN DEBUG] Acessando portal do Rio Grande do Norte...`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 });

    // Aguarda os inputs do formulário estarem presentes com base no HTML fornecido
    await page.waitForSelector('#nomeCompleto', { timeout: 10000 });
    await page.waitForSelector('#cpf', { timeout: 10000 });

    // Normalização dos dados de entrada
    const rawCpf = dados.candidateCpf || dados.cpf || '';
    const rawName = dados.candidateName || dados.nome || '';
    const cpfLimpo = String(rawCpf).replace(/\D/g, '');

    console.log(`[PCRN DEBUG] Preenchendo formulário para: ${rawName} (CPF: ${cpfLimpo})`);

    // Preenche os campos do formulário disparando eventos nativos
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

      setVal('#nomeCompleto', payload.nome);
      setVal('#cpf', payload.cpf);
    }, {
      nome: rawName.toUpperCase().trim(),
      cpf: cpfLimpo
    });

    await new Promise(r => setTimeout(r, 1000));

    // Clica no botão #btnDeclaracao para submeter o formulário
    console.log('[PCRN DEBUG] Clicando no botão #btnDeclaracao...');
    
    // Como a action do form é GET para /siscert/Home/gerarDeclaracaoEmPDF, podemos clicar ou monitorar a navegação
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null),
      page.click('#btnDeclaracao').catch(async () => {
        await page.evaluate(() => document.getElementById('btnDeclaracao').click());
      })
    ]);

    const urlFinal = page.url();
    console.log(`[PCRN DEBUG] URL final após clique: ${urlFinal}`);

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'AUDITORIA PCRN CONCLUÍDA',
      mensagem: `URL final capturada: ${urlFinal}`
    };

  } catch (error) {
    console.error(`[PCRN DEBUG] Erro na auditoria:`, error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA AUDITORIA PCRN',
      mensagem: error.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
