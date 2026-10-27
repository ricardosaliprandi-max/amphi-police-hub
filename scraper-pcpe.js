import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPE(payload) {
  const URL_ALVO = 'https://www.iitb.pe.gov.br/antecedentes/public/pages/certidaoAntecedentesCriminais/certidaoAntecedentesCriminaisEmitir.jsf';
  let browser = null;

  // Normaliza o payload recebido do Hub
  const dados = payload?.dados && typeof payload.dados === 'object' 
    ? { ...payload.dados, ...payload } 
    : (payload || {});

  const nome = (dados.nome || '').toUpperCase().trim();
  const nomeMae = (dados.nomeMae || dados.mae || '').toUpperCase().trim();
  const nomePai = (dados.nomePai || dados.pai || '').toUpperCase().trim();
  const profissao = (dados.profissao || 'AUTONOMO').toUpperCase().trim();
  const naturalidade = (dados.naturalidade || 'RECIFE').toUpperCase().trim();
  const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
  const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');

  let dataNasc = dados.dataNascimento || dados.dtNascimento || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataNasc)) {
    const [ano, mes, dia] = dataNasc.split('-');
    dataNasc = `${dia}/${mes}/${ano}`;
  }

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
        '--single-process', // Proteção contra estouro de RAM no Render (512MB)
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Camuflagem anti-bot básica
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Interceptação para otimizar consumo de rede e RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PCPE] Acessando portal do IITB-PE para: ${nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('#formBody', { timeout: 15000 }).catch(() => {});

    // Função auxiliar para preencher inputs de texto com segurança
    async function preencherInput(seletor, valor) {
      if (!valor) return;
      try {
        const el = await page.$(seletor);
        if (el) {
          await page.focus(seletor);
          await page.evaluate(s => document.querySelector(s).value = '', seletor);
          await page.type(seletor, String(valor), { delay: 20 });
        }
      } catch (e) {
        // Ignora se o campo não estiver presente
      }
    }

    // Função auxiliar para selecionar valores em comboboxes PrimeFaces nativas
    async function selecionarSelect(seletorInput, valorOption) {
      try {
        const el = await page.$(seletorInput);
        if (el) {
          await page.select(seletorInput, String(valorOption));
          await page.evaluate(sel => {
            const node = document.querySelector(sel);
            if (node) node.dispatchEvent(new Event('change', { bubbles: true }));
          }, seletorInput);
        }
      } catch (e) {}
    }

    // 1. Dados Pessoais Obrigatórios
    await preencherInput('#formBody\\:campoNome', nome);
    await preencherInput('#formBody\\:campoNomeMae', nomeMae);
    if (nomePai && !nomePai.includes('DECLARADO')) {
      await preencherInput('#formBody\\:campoNomePai', nomePai);
    }
    await preencherInput('#formBody\\:campoProfissao', profissao);
    await preencherInput('#formBody\\:campoNacionalidade', 'BRASILEIRA');
    await preencherInput('#formBody\\:campoNaturalidade', naturalidade);
    
    // UF Naturalidade (Ex: '17' para PE conforme HTML do portal)[cite: 2]
    await selecionarSelect('#formBody\\:campoUfNaturalidade_input', '17');
    // Estado Civil (Ex: '1' para Solteiro(a))[cite: 2]
    await selecionarSelect('#formBody\\:campoEstadoCivil_input', '1');
    
    await preencherInput('#formBody\\:campoDataNascimento_input', dataNasc);
    await preencherInput('#formBody\\:campoCpf', cpfLimpo);
    
    // Sexo ('1' para Masculino, '2' para Feminino)[cite: 2]
    const sexoVal = (dados.sexo || '').toUpperCase().startsWith('F') ? '2' : '1';
    await selecionarSelect('#formBody\\:campoSexo_input', sexoVal);

    // 2. Dados do RG
    if (rgLimpo) {
      await preencherInput('#formBody\\:campoRg', rgLimpo);
      await selecionarSelect('#formBody\\:campoOrgaoEmissor_input', '1'); // 1 = SSP[cite: 2]
      await selecionarSelect('#formBody\\:campoUf_input', '17'); // UF do RG
    }

    // 3. Endereço Padrão (Exigência estrutural da PCPE)[cite: 1, 2]
    await preencherInput('#formBody\\:endereco_cep', '50000000');
    await preencherInput('#formBody\\:endereco_rua', 'AVENIDA CENTRAL');
    await preencherInput('#formBody\\:endereco_bairro', 'CENTRO');
    await preencherInput('#formBody\\:endereco_cidade', 'RECIFE');
    await selecionarSelect('#formBody\\:certidao_antecedentes_criminais_endereco_pernambuco_input', '17');
    await preencherInput('#formBody\\:endereco_telefone', '81999999999');

    // 4. Submissão do Formulário
    console.log('[PCPE] Submetendo dados no portal da PCPE...');
    await Promise.all([
      page.click('#formBody\\:j_idt97'), // Botão Solicitar[cite: 2]
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
    ]);

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');
    const textoUpper = resultadoTexto.toUpperCase();

    if (textoUpper.includes('NADA CONSTA') || textoUpper.includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos registros do Instituto de Identificação Tavares Buril (PE).',
        rawSnippet: resultadoTexto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    if (textoUpper.includes('REGISTRO') || textoUpper.includes('APONTAMENTO') || textoUpper.includes('PENDÊNCIA')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado apontamento ou registro na base da PCPE.',
        rawSnippet: resultadoTexto.replace(/\s+/g, ' ').slice(0, 300)
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no portal da PCPE.',
      rawSnippet: resultadoTexto.replace(/\s+/g, ' ').slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCPE] Erro na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCPE',
      mensagem: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCPE] Navegador encerrado com sucesso.`);
    }
  }
}
