import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  const URL_ALVO = 'https://sinf2.policiacivil.rn.gov.br/siscert/Home/index';
  
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

    // Interceptação defensiva de recursos estáticos para evitar lentidão e timeout
    await page.setRequestInterception(true);
    page.on('request', req => {
      const resourceType = req.resourceType();
      const url = req.url();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
        if (req.method() === 'GET' || req.method() === 'POST') {
          console.log(`[PCRN DEBUG REDE] Método: ${req.method()} | URL: ${url}`);
        }
      }
    });

    // Monitora respostas para capturar a rota de PDF
    page.on('response', async res => {
      const url = res.url();
      const contentType = res.headers()['content-type'] || '';
      if (url.includes('gerarDeclaracaoEmPDF') || contentType.includes('application/pdf')) {
        console.log(`[PCRN DEBUG RESPOSTA] URL: ${url} | Content-Type: ${contentType} | Status: ${res.status()}`);
      }
    });

    console.log(`[PCRN DEBUG] Acessando portal do Rio Grande do Norte (com timeout estendido)...`);
    
    // Usamos domcontentloaded e elevamos o timeout para 50s
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 50000 });

    // Aguarda os inputs do formulário estarem presentes
    await page.waitForSelector('#nomeCompleto', { timeout: 15000 });
    await page.waitForSelector('#cpf', { timeout: 15000 });

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

    // Clica no botão #btnDeclaracao e aguarda a submissão (ação GET para gerar o PDF)
    console.log('[PCRN DEBUG] Clicando no botão #btnDeclaracao...');
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => null),
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
