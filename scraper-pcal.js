import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCAL(dados) {
  const URL_ALVO = 'https://idseg.institutodeidentificacao.al.gov.br/Vsoft.iDSPS.Agendamento/EmitirAAC';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. AUDITORIA TOTAL DE REDE: Loga absolutamente todas as chamadas POST ou AJAX da página
    page.on('request', req => {
      if (req.method() === 'POST' || req.resourceType() === 'fetch' || req.resourceType() === 'xhr') {
        console.log(`[AUDIT REDE] Método: ${req.method()} | URL: ${req.url()}`);
        console.log(`[AUDIT HEADERS]:`, JSON.stringify(req.headers(), null, 2));
        if (req.postData()) {
          console.log(`[AUDIT PAYLOAD ENVIADO]:`, req.postData());
        }
      }
    });

    page.on('response', async res => {
      const url = res.url();
      if (url.includes('api') || url.includes('Emitir')) {
        console.log(`[AUDIT RESPOSTA] URL: ${url} | Status: ${res.status()}`);
        try {
          const bodyText = await res.text();
          console.log(`[AUDIT CORPO DA RESPOSTA]:`, bodyText.slice(0, 500));
        } catch (e) {}
      }
    });

    console.log(`[PCAL DEBUG] Acessando portal para auditoria...`);
    await page.goto(URL_ALVO, { waitUntil: 'networkidle0', timeout: 40000 });

    // 2. Extrai e exibe no console os tokens reais presentes no HTML
    const tokensDoHtml = await page.evaluate(() => {
      const csrf = document.querySelector('input[name="__RequestVerificationToken"]');
      const internalKey = document.querySelector('meta[name="internal-key"]');
      return {
        csrfToken: csrf ? csrf.value : 'NÃO ENCONTRADO',
        internalKey: internalKey ? internalKey.getAttribute('content') : 'NÃO ENCONTRADO'
      };
    });

    console.log('[PCAL DEBUG] Tokens extraídos do DOM:', tokensDoHtml);

    // 3. Tenta simular o preenchimento e clique observando o comportamento da página
    await page.waitForSelector('#form', { timeout: 10000 }).catch(() => {});

    // Executa um teste de submissão nativa via console do navegador para ver se o JS do site lida com o erro
    const testeNativo = await page.evaluate(async () => {
      // Procura por funções globais expostas no script custom-emitir-aac.js
      return {
        funcoesDisponiveis: Object.keys(window).filter(k => k.toLowerCase().includes('emitir') || k.toLowerCase().includes('pesquisar') || k.toLowerCase().includes('ajax'))
      };
    });

    console.log('[PCAL DEBUG] Funções globais mapeadas no window:', testeNativo);

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'AUDITORIA CONCLUÍDA',
      mensagem: 'Verifique os logs do console do Render/Node.js para analisar as requisições de rede capturadas.'
    };

  } catch (error) {
    console.error(`[PCAL DEBUG] Erro:`, error);
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
