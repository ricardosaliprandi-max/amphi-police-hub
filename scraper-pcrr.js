import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRR(dados) {
  const URL_ALVO = 'http://antecedentes.ssp.rr.gov.br/pages/Atestado/IUAtestado.aspx';

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

    console.log(`[PCRR] Acessando portal de antecedentes da PCRR para: ${dados.nome}`);
    
    // Tratamento defensivo de DNS/Timeout para o portal de Roraima
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(err => {
      throw new Error(`Portal de Roraima inacessível ou fora do ar (DNS/Timeout): ${err.message}`);
    });

    // Aguarda o formulário carregar de forma flexível
    await page.waitForSelector('form, input', { timeout: 15000 }).catch(() => {});

    // Função auxiliar segura para preencher inputs
    async function preencherCampo(seletores, valor) {
      if (!valor) return;
      for (const sel of seletores) {
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
    await preencherCampo([
      'input[name*="Nome" i]', 
      'input[id*="Nome" i]', 
      'input[name*="nome" i]'
    ], dados.nome.toUpperCase().trim());

    // 2. Filiação 1 (Mãe)
    if (dados.nomeMae) {
      await preencherCampo([
        'input[name*="Filiacao1" i]', 
        'input[id*="Filiacao1" i]', 
        'input[name*="Mae" i]', 
        'input[id*="Mae" i]'
      ], dados.nomeMae.toUpperCase().trim());
    }

    // 3. Filiação 2 (Pai) - Opcional
    if (dados.nomePai && dados.nomePai.trim() !== '' && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await preencherCampo([
        'input[name*="Filiacao2" i]', 
        'input[id*="Filiacao2" i]', 
        'input[name*="Pai" i]', 
        'input[id*="Pai" i]'
      ], dados.nomePai.toUpperCase().trim());
    }

    // 4. Data de Nascimento
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo([
      'input[name*="Nascimento" i]', 
      'input[id*="Nascimento" i]', 
      'input[name*="DataNasc" i]'
    ], dataFormatada);

    // 5. Tipo de Documento e Número
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    const docValor = cpfLimpo || rgLimpo;

    const selectTipoDoc = await page.$('select[name*="Tipo" i], select[id*="Tipo" i], select');
    if (selectTipoDoc) {
      await page.evaluate((valorTipo) => {
        const select = document.querySelector('select[name*="Tipo" i], select[id*="Tipo" i], select');
        if (select) {
          for (let opt of select.options) {
            if (opt.value.toUpperCase().includes(valorTipo) || opt.text.toUpperCase().includes(valorTipo)) {
              select.value = opt.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }
      }, cpfLimpo ? 'CPF' : 'RG');
    }

    await preencherCampo([
      'input[name*="Documento" i]', 
      'input[id*="Documento" i]', 
      'input[name*="Cpf" i]', 
      'input[name*="Rg" i]'
    ], docValor);

    // 6. Submissão segura
    console.log('[PCRR] Submetendo dados para emissão...');
    const botaoClicado = await page.evaluate(() => {
      const elementos = Array.from(document.querySelectorAll('input[type="submit"], button, input[type="button"]'));
      const alvo = elementos.find(el => {
        const val = (el.value || el.innerText || '').toLowerCase();
        return val.includes('gerar') || val.includes('consultar') || val.includes('pesquisar') || val.includes('emitir');
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

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    await new Promise(r => setTimeout(r, 4000));
    
    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil de Roraima.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCRR.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCRR.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCRR] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCRR',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCRR] Navegador encerrado com sucesso.`);
    }
  }
}
