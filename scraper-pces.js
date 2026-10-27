import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(dados) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  
  let browser = null;
  let page = null;
  let novaAba = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-infobars',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    });

    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    const nomeBusca = dados?.nome || 'Cidadão';
    console.log(`[PCES] Acessando portal oficial com camuflagem anti-bot para: ${nomeBusca}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da SESP-ES: ${err.message}`);
    });

    await page.waitForSelector('#formMaster', { timeout: 20000 }).catch(() => {
      throw new Error('O formulário principal (#formMaster) não foi renderizado pelo portal.');
    });

    let tipoDocValue = "1";
    const docTipoDesejado = (dados?.tipoDocumento || 'RG').toUpperCase();
    if (docTipoDesejado.includes('CNH')) tipoDocValue = "7";
    if (docTipoDesejado.includes('CIN')) tipoDocValue = "12";

    await page.evaluate((val) => {
      const select = document.querySelector('#j_idt57_input');
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof widget_j_idt57 !== 'undefined' && widget_j_idt57.selectValue) {
          widget_j_idt57.selectValue(val);
        }
      }
    }, tipoDocValue);

    await new Promise(r => setTimeout(r, 500));

    const docLimpo = String(dados?.rg || dados?.numero || '').replace(/\D/g, '');
    if (docLimpo) {
      await page.waitForSelector('#numero', { timeout: 5000 }).catch(() => {});
      await page.evaluate((val) => {
        const el = document.querySelector('#numero');
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, docLimpo);
    }

    if (dados?.nome) {
      await page.waitForSelector('#nomeIndividuo', { timeout: 5000 }).catch(() => {});
      await page.evaluate((val) => {
        const el = document.querySelector('#nomeIndividuo');
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, dados.nome.toUpperCase().trim());
    }

    if (dados?.nomePai && dados.nomePai.trim() !== '' && !dados.nomePai.toUpperCase().includes('NÃO DECLARADO') && !dados.nomePai.toUpperCase().includes('NAO DECLARADO')) {
      await page.waitForSelector('#nomePai', { timeout: 5000 }).catch(() => {});
      await page.evaluate((val) => {
        const el = document.querySelector('#nomePai');
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, dados.nomePai.toUpperCase().trim());
    }

    if (dados?.nomeMae && dados.nomeMae.trim() !== '') {
      await page.waitForSelector('#nomeMae', { timeout: 5000 }).catch(() => {});
      await page.evaluate((val) => {
        const el = document.querySelector('#nomeMae');
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, dados.nomeMae.toUpperCase().trim());
    }

    let dataFormatada = dados?.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    if (dataFormatada) {
      await page.waitForSelector('#dtNascimento_input', { timeout: 5000 }).catch(() => {});
      await page.evaluate((val) => {
        const el = document.querySelector('#dtNascimento_input');
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, dataFormatada);
    }

    const targetPromise = new Promise(resolve => {
      browser.once('targetcreated', async target => {
        try {
          const p = await target.page();
          resolve(p);
        } catch (e) {
          resolve(null);
        }
      });
      setTimeout(() => resolve(null), 8000);
    });

    console.log('[PCES] Disparando botão Emitir Atestado...');
    await page.click('#btnPesquisar').catch(async () => {
      await page.evaluate(() => document.getElementById('btnPesquisar')?.click());
    });

    novaAba = await targetPromise;

    if (novaAba) {
      try {
        await novaAba.waitForLoadState ? novaAba.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}) : new Promise(r => setTimeout(r, 2000));
        const textoAba = await novaAba.evaluate(() => document.body.innerText || '');
        if (textoAba.includes('NADA CONSTA') || textoAba.includes('ATESTADO DE ANTECEDENTES') || textoAba.includes('CERTIDÃO')) {
          await novaAba.close().catch(() => {});
          novaAba = null;
          return {
            sucesso: true,
            hasRecords: false,
            statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
            mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
            rawSnippet: textoAba.slice(0, 300)
          };
        }
      } catch (e) {
        // Fallback to main page evaluation
      } finally {
        if (novaAba) {
          await novaAba.close().catch(() => {});
          novaAba = null;
        }
      }
    }

    const resultadoAnalise = await page.evaluate(() => {
      const growl = document.querySelector('#growlGeral, .ui-growl-message, .ui-messages-error-summary');
      if (growl && growl.innerText.trim() !== '') {
        return { tipo: 'GROWL', texto: growl.innerText.trim() };
      }

      const dlgPendencia = document.querySelector('#j_idt101');
      if (dlgPendencia && !dlgPendencia.classList.contains('ui-overlay-hidden')) {
        return { tipo: 'PENDENCIA', texto: 'Encaminhe cópia de documento para atestado@pci.es.gov.br' };
      }

      const dlgInconsistente = document.querySelector('#j_idt115');
      if (dlgInconsistente && !dlgInconsistente.classList.contains('ui-overlay-hidden')) {
        return { tipo: 'INCONSISTENTE', texto: 'Dados inconsistentes com o Instituto de Identificação do ES.' };
      }

      const corpo = document.body.innerText || '';
      return { tipo: 'CORPO', texto: corpo };
    });

    if (resultadoAnalise.tipo === 'PENDENCIA') {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'PENDÊNCIA CADASTRAL / APONTAMENTO',
        mensagem: resultadoAnalise.texto
      };
    }

    if (resultadoAnalise.tipo === 'INCONSISTENTE') {
      return {
        sucesso: true,
        hasRecords: false,
        riskLevel: 'MEDIUM',
        statusTexto: 'DADOS INCONSISTENTES',
        mensagem: resultadoAnalise.texto
      };
    }

    if (resultadoAnalise.tipo === 'GROWL' && resultadoAnalise.texto) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ALERTA DO SISTEMA SESP',
        mensagem: resultadoAnalise.texto
      };
    }

    const textoTotal = resultadoAnalise.texto.toUpperCase();

    if (textoTotal.includes('ORACLE ACCESS MANAGER') || textoTotal.includes('FATAL ERROR')) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'BLOQUEIO DE FIREWALL (OAM)',
        mensagem: 'O portal da SESP-ES barrou a conexão automatizada via proxy/nuvem.'
      };
    }

    if (textoTotal.includes('NADA CONSTA') || textoTotal.includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros da Polícia Civil / Científica do ES.',
        rawSnippet: resultadoAnalise.texto.slice(0, 300)
      };
    }

    if (textoTotal.includes('EXISTEM REGISTROS') || textoTotal.includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro de antecedentes criminais na base da PCES.'
      };
    }

    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'RESPOSTA INDEFINIDA',
      mensagem: 'A automação disparou a consulta, mas o portal não retornou o atestado nem exibiu modais mapeados.',
      rawSnippet: resultadoAnalise.texto.replace(/\s+/g, ' ').slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCES] Erro crítico na execução:`, error?.message || error);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCES',
      mensagem: error?.message || 'Erro desconhecido'
    };
  } finally {
    if (novaAba) {
      await novaAba.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCES] Navegador encerrado com sucesso.`);
    }
  }
}
