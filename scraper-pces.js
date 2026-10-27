import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCES(dados) {
  const URL_ALVO = 'https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf';
  
  let browser = null;
  let page = null;

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
        '--single-process',
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

    // Permitir scripts e XHR do PrimeFaces, abortando apenas recursos pesados desnecessários
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    const nomeBusca = dados?.nome || 'Cidadão';
    console.log(`[PCES] Acessando portal oficial para: ${nomeBusca}`);
    
    await page.goto(URL_ALVO, { waitUntil: 'networkidle2', timeout: 40000 }).catch(err => {
      throw new Error(`Falha de conexão com o portal da SESP-ES: ${err.message}`);
    });

    await page.waitForSelector('#formMaster', { timeout: 20000 }).catch(() => {
      throw new Error('O formulário principal (#formMaster) não foi renderizado pelo portal.');
    });

    // 1. Seleção robusta do Tipo de Documento no PrimeFaces
    let tipoDocValue = "1"; // 1 = RG por padrão
    const docTipoDesejado = (dados?.tipoDocumento || 'RG').toUpperCase();
    if (docTipoDesejado.includes('CNH')) tipoDocValue = "7";
    if (docTipoDesejado.includes('CIN')) tipoDocValue = "12";

    await page.evaluate((val) => {
      const select = document.querySelector('select[id$="input"]') || document.querySelector('#j_idt57_input');
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // Tenta acionar disparadores jQuery / PrimeFaces se disponíveis
        if (window.jQuery) {
          window.jQuery(select).trigger('change');
        }
      }
    }, tipoDocValue);

    await new Promise(r => setTimeout(r, 600));

    // 2. Preenchimento do Número do Documento
    const docLimpo = String(dados?.rg || dados?.numero || '').replace(/\D/g, '');
    if (docLimpo) {
      await page.type('#numero', docLimpo, { delay: 30 }).catch(async () => {
        await page.evaluate((val) => {
          const el = document.getElementById('numero');
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, docLimpo);
      });
    }

    // 3. Nome Completo
    if (dados?.nome) {
      await page.type('#nomeIndividuo', dados.nome.toUpperCase().trim(), { delay: 20 }).catch(async () => {
        await page.evaluate((val) => {
          const el = document.getElementById('nomeIndividuo');
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, dados.nome.toUpperCase().trim());
      });
    }

    // 4. Nome do Pai (se válido)
    if (dados?.nomePai && dados.nomePai.trim() !== '' && !dados.nomePai.toUpperCase().includes('NÃODEC')) {
      const nomePaiLimpo = dados.nomePai.toUpperCase().trim();
      await page.type('#nomePai', nomePaiLimpo, { delay: 20 }).catch(async () => {
        await page.evaluate((val) => {
          const el = document.getElementById('nomePai');
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, nomePaiLimpo);
      });
    }

    // 5. Nome da Mãe
    if (dados?.nomeMae && dados.nomeMae.trim() !== '') {
      const nomeMaeLimpo = dados.nomeMae.toUpperCase().trim();
      await page.type('#nomeMae', nomeMaeLimpo, { delay: 20 }).catch(async () => {
        await page.evaluate((val) => {
          const el = document.getElementById('nomeMae');
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, nomeMaeLimpo);
      });
    }

    // 6. Data de Nascimento (Formato DD/MM/YYYY)
    let dataFormatada = dados?.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataFormatada)) {
      const [ano, mes, dia] = dataFormatada.split('-');
      dataFormatada = `${dia}/${mes}/${ano}`;
    }
    if (dataFormatada) {
      await page.evaluate((val) => {
        const input = document.getElementById('dtNascimento_input');
        if (input) {
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (window.jQuery) {
            window.jQuery(input).val(val).trigger('change');
          }
        }
      }, dataFormatada);
    }

    await new Promise(r => setTimeout(r, 800));

    // 7. Disparar Pesquisa e Aguardar Requisição AJAX / Atualização do DOM
    console.log('[PCES] Disparando botão Emitir Atestado (AJAX PrimeFaces)...');
    
    const [response] = await Promise.all([
      page.waitForResponse(res => res.url().includes('pesquisaantecedentes') && res.status() === 200, { timeout: 15000 }).catch(() => null),
      page.click('#btnPesquisar').catch(async () => {
        await page.evaluate(() => document.getElementById('btnPesquisar')?.click());
      })
    ]);

    // Aguardar renderização completa pós-AJAX
    await new Promise(r => setTimeout(r, 3000));

    // 8. Analisar os resultados na página atual
    const resultadoAnalise = await page.evaluate(() => {
      // Verificar mensagens de erro do sistema (Growl / Messages)
      const growl = document.querySelector('#growlGeral, .ui-growl-message, .ui-messages-error-summary, .ui-message-error');
      if (growl && growl.innerText.trim() !== '') {
        return { tipo: 'GROWL', texto: growl.innerText.trim() };
      }

      // Verificar modais de pendência cadastral ou divergência
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
        rawSnippet: resultadoAnalise.texto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    if (textoTotal.includes('EXISTEM REGISTROS') || textoTotal.includes('APONTAMENTO') || textoTotal.includes('CERTIDÃO POSITIVA')) {
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
      mensagem: 'A automação disparou a consulta, mas o portal retornou estado indefinido ou o formulário exigiu nova validação.',
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
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCES] Navegador encerrado com sucesso.`);
    }
  }
}
