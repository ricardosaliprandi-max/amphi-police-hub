import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMS(dados) {
  const URL_ALVO = 'https://antecedentes.sejusp.ms.gov.br/pages/MasterPages/IUPrincipal.aspx';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Auditoria rigorosa de requisições de rede (POST, XHR, Fetch)
    page.on('request', req => {
      if (req.method() === 'POST' || req.resourceType() === 'fetch' || req.resourceType() === 'xhr') {
        console.log(`[PCMS AUDIT] Método: ${req.method()} | URL: ${req.url()}`);
        if (req.postData()) {
          console.log(`[PCMS AUDIT PAYLOAD]:`, req.postData());
        }
      }
    });

    page.on('response', async res => {
      const url = res.url();
      if (url.includes('Atestado') || url.includes('api') || url.includes('Servicos')) {
        console.log(`[PCMS AUDIT RESPOSTA] URL: ${url} | Status: ${res.status()}`);
        try {
          const bodyText = await res.text();
          if (bodyText.length < 1000) {
            console.log(`[PCMS AUDIT CORPO]:`, bodyText);
          }
        } catch (e) {}
      }
    });

    console.log(`[PCMS DEBUG] Acessando layout principal...`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle0', timeout: 40000 });

    // 2. O portal usa iframe (#myFrame). Precisamos interagir com o conteúdo interno do iframe.
    console.log(`[PCMS DEBUG] Aguardando carregamento do iframe principal (#myFrame)...`);
    
    await page.waitForSelector('#myFrame', { timeout: 15000 });
    
    // Aguarda o frame carregar a página interna (ex: IUMeio.aspx ou a página de atestado)
    let frameInterno = null;
    let tentativas = 0;
    while (!frameInterno && tentativas < 15) {
      const frames = page.frames();
      frameInterno = frames.find(f => f.url().includes('Atestado') || f.url().includes('Meio'));
      if (!frameInterno) {
        await new Promise(r => setTimeout(r, 1000));
        tentativas++;
      }
    }

    // Se não encontrou pelo URL, pega o primeiro frame filho do myFrame
    if (!frameInterno) {
      const elementHandle = await page.$('#myFrame');
      frameInterno = await elementHandle.contentFrame();
    }

    if (frameInterno) {
      console.log(`[PCMS DEBUG] Frame interno capturado com sucesso: ${frameInterno.url()}`);
      
      // Tenta clicar no menu "Solicitar" se estivermos na página inicial IUPrincipal
      const linkSolicitarEncontrado = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const sol = links.find(l => l.innerText.toLowerCase().includes('solicitar'));
        if (sol) {
          sol.click();
          return true;
        }
        return false;
      });

      if (linkSolicitarEncontrado) {
        console.log(`[PCMS DEBUG] Link 'Solicitar' acionado no menu lateral.`);
        await new Promise(r => setTimeout(r, 3000));
      }

      // Re-captura o frame interno atualizado após o clique no menu
      const framesAtualizados = page.frames();
      const frameAtestado = framesAtualizados.find(f => f.url().includes('IUAtestado.aspx')) || frameInterno;

      // Inspeciona os inputs disponíveis no formulário de atestado
      const inputsNoFrame = await frameAtestado.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, select'));
        return inputs.map(el => ({
          id: el.id,
          name: el.name,
          type: el.type,
          placeholder: el.placeholder
        }));
      });

      console.log(`[PCMS DEBUG] Campos de formulário encontrados no iframe:`, inputsNoFrame);
    } else {
      console.log(`[PCMS DEBUG] Aviso: Não foi possível interagir com o iframe #myFrame.`);
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'AUDITORIA PCMS CONCLUÍDA',
      mensagem: 'Verifique os logs do Render para analisar o mapeamento do iframe e dos inputs.'
    };

  } catch (error) {
    console.error(`[PCMS DEBUG] Erro crítico:`, error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA AUDITORIA PCMS',
      mensagem: error.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
