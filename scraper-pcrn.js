import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  const URL_ALVO = 'https://siscert.deic.rn.gov.br/';

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

    console.log(`[PCRN] Acessando portal SISCERT da PCRN para: ${dados.nome}`);
    
    // Tratamento defensivo de DNS/Timeout para o portal do RN
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(err => {
      throw new Error(`Portal do Rio Grande do Norte inacessível ou fora do ar (DNS/Timeout): ${err.message}`);
    });

    // Aguarda o formulário carregar de forma flexível
    await page.waitForSelector('form, input', { timeout: 15000 }).catch(() => {});

    // Função auxiliar segura para preencher inputs
    async function preencherCampo(seletorPadrao, seletoresAlternativos, valor) {
      if (!valor) return;
      const todos = [seletorPadrao, ...seletoresAlternativos];
      for (const sel of todos) {
        try {
          const el = await page.$(sel);
          if (el) {
            await page.focus(sel);
            await page.evaluate(s => document.querySelector(s).value = '', sel);
            await page.type(sel, String(valor), { delay: 30 });
            return true;
          }
        } catch (e) {
          // Tenta o próximo
        }
      }
      return false;
    }

    // 1. Preenchimento do Nome Completo
    await preencherCampo('input[name="nomeCompleto"]', ['input[id*="nome" i]', 'input[name*="nome" i]'], dados.nome.toUpperCase().trim());

    // 2. Preenchimento do CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '').slice(0, 11);
    await preencherCampo('input[name="cpf"]', ['input[id*="cpf" i]', 'input[name*="cpf" i]'], cpfLimpo);

    // 3. Submissão segura (Gerar Declaração)
    console.log('[PCRN] Submetendo dados para geração da certidão...');
    
    const botaoClicado = await page.evaluate(() => {
      const btn = document.querySelector('button#btnDeclaracao, button[type="submit"], input[type="submit"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!botaoClicado) {
      await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    await new Promise(r => setTimeout(r, 3000));

    // Analisa a página resultante
    const urlAtual = page.url();
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (urlAtual.includes('gerarDeclaracaoEmPDF') || resultadoTexto.toUpperCase().includes('DECLARAÇÃO') || resultadoTexto.toUpperCase().includes('CERTIDÃO')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO / DECLARAÇÃO GERADA',
        mensagem: 'Declaração de antecedentes criminais emitida com sucesso na base da PCRN.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCRN.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'CONSULTA PROCESSADA',
      mensagem: 'Solicitação submetida com sucesso no portal da PCRN.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCRN] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCRN',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCRN] Navegador encerrado com sucesso.`);
    }
  }
}
