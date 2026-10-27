import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCMA(dados) {
  // URL padrão oficial de antecedentes do Maranhão
  const URL_ALVO = 'https://antecedentes.ssp.ma.gov.br';

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Essencial para gerir o limite restrito de 512MB de RAM no Render
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

    console.log(`[PCMA] Acessando portal de antecedentes da SSP-MA para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda a aplicação SPA renderizar os componentes do formulário no DOM
    await page.waitForSelector('input', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000)); // Tempo para hidratação do JS

    // Função auxiliar segura para preencher inputs por múltiplos seletores
    async function preencherCampo(seletores, valor) {
      if (!valor) return;
      for (const seletor of seletores) {
        try {
          const el = await page.$(seletor);
          if (el) {
            await page.focus(seletor);
            await page.evaluate(s => document.querySelector(s).value = '', seletor);
            await page.type(seletor, String(valor), { delay: 30 });
            return true;
          }
        } catch (e) {
          // Tenta o próximo
        }
      }
      return false;
    }

    // 1. Preenchimento do CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await preencherCampo([
      'input[name*="cpf" i]', 
      'input[placeholder*="CPF" i]', 
      'input[formcontrolname*="cpf" i]',
      'input[id*="cpf" i]'
    ], cpfLimpo);

    // 2. Preenchimento do Nome Completo
    await preencherCampo([
      'input[name*="nome" i]', 
      'input[placeholder*="nome" i]', 
      'input[formcontrolname*="nome" i]',
      'input[id*="nome" i]'
    ], dados.nome.toUpperCase().trim());

    // 3. Preenchimento da Data de Nascimento
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo([
      'input[name*="nasc" i]', 
      'input[placeholder*="data" i]', 
      'input[placeholder*="dd/mm" i]',
      'input[formcontrolname*="nasc" i]'
    ], dataFormatada);

    // 4. Preenchimento do Nome da Mãe
    if (dados.nomeMae && dados.nomeMae.trim() !== '') {
      await preencherCampo([
        'input[name*="mae" i]', 
        'input[placeholder*="mãe" i]',
        'input[formcontrolname*="mae" i]'
      ], dados.nomeMae.toUpperCase().trim());
    }

    // 5. Acionar o Botão de Consulta / Pesquisa de forma segura (sem seletores inválidos)
    console.log('[PCMA] Submetendo formulário de consulta...');
    const botaoClicado = await page.evaluate(() => {
      const elementos = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
      const alvo = elementos.find(el => {
        const txt = el.innerText.toLowerCase() || el.value?.toLowerCase() || '';
        return txt.includes('pesquisar') || txt.includes('consultar') || txt.includes('emitir') || el.type === 'submit';
      });
      if (alvo) {
        alvo.click();
        return true;
      }
      return false;
    });

    if (!botaoClicado) {
      await page.keyboard.press('Enter');
    }

    // Aguarda o retorno da API / renderização do resultado
    await new Promise(r => setTimeout(r, 5000));
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    // Análise de Resposta
    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros de antecedentes da Polícia Civil do Maranhão.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('REGISTRO') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da SSP-MA.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'CONSULTA REALIZADA',
      mensagem: 'Solicitação processada no portal da SSP-MA.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCMA] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCMA',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCMA] Navegador encerrado com sucesso.`);
    }
  }
}
