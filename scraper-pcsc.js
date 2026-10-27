import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCSC(dados) {
  const URL_ALVO = 'https://delegaciavirtual.sc.gov.br/atestado-antecedentes/novo';

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

    console.log(`[PCSC] Acessando Delegacia Virtual de Santa Catarina para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda a aplicação SPA renderizar os inputs no DOM
    await page.waitForSelector('input', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500)); // Tempo para hidratação do JS

    // 1. Validar regra de UF do RG (Exigência restrita de SC para o canal digital)
    const ufRg = (dados.ufRg || dados.uf || 'SC').toUpperCase();
    if (ufRg !== 'SC') {
      return {
        sucesso: false,
        canalInstitucional: true,
        statusTexto: 'EXIGE RG DE SANTA CATARINA',
        mensagem: 'O portal online da PCSC processa digitalmente apenas RGs emitidos em Santa Catarina. Documentos de outros estados exigem solicitação via canal presencial ou DIPC.'
      };
    }

    // Função auxiliar segura para preencher inputs por múltiplos seletores
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

    // 2. Preenchimento de Data de Nascimento
    let dataFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo([
      'input[name*="data" i]', 
      'input[placeholder*="data" i]', 
      'input[id*="data" i]',
      'input[formcontrolname*="nasc" i]'
    ], dataFormatada);

    // 3. Preenchimento do CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await preencherCampo([
      'input[name*="cpf" i]', 
      'input[id*="cpf" i]',
      'input[formcontrolname*="cpf" i]'
    ], cpfLimpo);

    // 4. Preenchimento do RG (sem dígito verificador, conforme orientação do portal de SC)
    let rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo.length > 1) {
      rgLimpo = rgLimpo.slice(0, -1); 
    }
    await preencherCampo([
      'input[name*="rg" i]', 
      'input[id*="rg" i]',
      'input[formcontrolname*="rg" i]'
    ], rgLimpo);

    // 5. Seleção da UF do RG (Santa Catarina)
    const selectUf = await page.$('select[name*="uf" i], select[id*="uf" i]');
    if (selectUf) {
      await page.select('select[name*="uf" i], select[id*="uf" i]', 'SANTA CATARINA').catch(() => {});
    }

    // 6. Submissão segura (Sem seletores inválidos como :has-text)
    console.log('[PCSC] Submetendo solicitação de atestado...');
    const botaoClicado = await page.evaluate(() => {
      const elementos = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
      const alvo = elementos.find(el => {
        const txt = (el.innerText || el.value || '').toLowerCase();
        return txt.includes('solicitar') || txt.includes('consultar') || txt.includes('pesquisar') || el.type === 'submit';
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

    // Aguarda o processamento da SPA / navegação
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    await new Promise(r => setTimeout(r, 4000));

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros da Polícia Civil de Santa Catarina.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCSC.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da Delegacia Virtual de SC.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCSC] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCSC',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCSC] Navegador encerrado com sucesso.`);
    }
  }
}
