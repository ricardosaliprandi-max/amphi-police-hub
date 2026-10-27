import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPB(dados) {
  // Nota: Se a URL oficial sofrer alteração de subdomínio/portal pelo estado, mantenha atualizada aqui
  const URL_ALVO = 'https://antecedentes.ssp.pb.gov.br/';

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

    console.log(`[PCPB] Acessando portal da PCPB (Vsoft iDSPS) para: ${dados.nome}`);
    
    // Tentativa de acesso com tratamento de DNS/Timeout para não crashar o hub caso o portal esteja fora do ar
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(err => {
      throw new Error(`Portal da Paraíba inacessível ou fora do ar (DNS/Timeout): ${err.message}`);
    });

    // Aguarda o formulário carregar de forma genérica
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

    // 1. Preenchimento de RG e Órgão Expedidor
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await preencherCampo('input[name="rg"]', ['input[id*="rg" i]', 'input[name*="rg" i]'], rgLimpo);
      await preencherCampo('input[name="orgaoExpedidor"]', ['input[id*="orgao" i]', 'input[name*="orgao" i]'], (dados.orgaoExpedidor || 'SSP').toUpperCase());
    }

    // 2. Preenchimento do Nome Completo
    await preencherCampo('input[name="nome"]', ['input[id*="nome" i]', 'input[name*="nome" i]'], dados.nome.toUpperCase().trim());

    // 3. Data de Nascimento (DD/MM/AAAA)
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo('input[name="dataNascimento"]', ['input[id*="nascimento" i]', 'input[name*="nasc" i]'], dataFormatada);

    // 4. Preenchimento do CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await preencherCampo('input[name="cpf"]', ['input[id*="cpf" i]', 'input[name*="cpf" i]'], cpfLimpo);

    // 5. Filiação (Mãe e Pai)
    if (dados.nomeMae) {
      await preencherCampo('input[name="mae"]', ['input[id*="mae" i]', 'input[name*="filiacao1" i]'], dados.nomeMae.toUpperCase().trim());
    }
    if (dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await preencherCampo('input[name="pai"]', ['input[id*="pai" i]', 'input[name*="filiacao2" i]'], dados.nomePai.toUpperCase().trim());
    }

    // 6. Submissão segura (Clicar no botão "Emitir")
    console.log('[PCPB] Clicando no botão Emitir...');
    const botaoClicado = await page.evaluate(() => {
      const btn = document.querySelector('button#btEmitir, button[type="submit"], input[type="submit"]');
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
    await new Promise(r => setTimeout(r, 4000));

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil da Paraíba.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes na base da PCPB.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no sistema da PCPB.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCPB] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCPB',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCPB] Navegador encerrado com sucesso.`);
    }
  }
}
