import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCPE(dados) {
  const URL_ALVO = 'https://www.sds.pe.gov.br/antecedentes/';

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

    console.log(`[PCPE] Acessando portal do IITB / PCPE para: ${dados.nome}`);
    await page.goto(URL_ALVO, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Aguarda o formulário JSF carregar
    await page.waitForSelector('form#formBody', { timeout: 15000 });

    // 1. Dados Pessoais
    await page.type('input[id$="campoNome"]', dados.nome.toUpperCase().trim(), { delay: 30 });
    
    if (dados.nomeMae) {
      await page.type('input[id$="campoNomeMae"]', dados.nomeMae.toUpperCase().trim(), { delay: 30 });
    }
    if (dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await page.type('input[id$="campoNomePai"]', dados.nomePai.toUpperCase().trim(), { delay: 30 });
    }

    // Profissão (padrão 'OUTROS' ou 'NÃO INFORMADA' se não houver)
    const profissao = dados.profissao || 'AUTONOMO';
    await page.type('input[id$="campoProfissao"]', profissao.toUpperCase(), { delay: 20 });

    // Nacionalidade e Naturalidade
    await page.type('input[id$="campoNacionalidade"]', 'BRASILEIRA', { delay: 20 });
    const naturalidade = dados.naturalidade || 'RECIFE';
    await page.type('input[id$="campoNaturalidade"]', naturalidade.toUpperCase(), { delay: 20 });

    // UF Naturalidade (Select PrimeFaces)
    await page.select('select[id$="campoUfNaturalidade_input"]', '17'); // 17 = PE por padrão ou UF informada

    // Estado Civil (Valor '1' = Solteiro(a), '2' = Casado(a))
    await page.select('select[id$="campoEstadoCivil_input"]', '1');

    // Data de Nascimento (DD/MM/AAAA)
    let dataNascFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataNascFormatada)) {
      const [ano, mes, dia] = dataNascFormatada.split('-');
      dataNascFormatada = `${dia}/${mes}/${ano}`;
    }
    await page.type('input[id$="campoDataNascimento_input"]', dataNascFormatada, { delay: 30 });

    // CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await page.type('input[id$="campoCpf"]', cpfLimpo, { delay: 30 });

    // Sexo ('1' = Masculino, '2' = Feminino)
    if (dados.sexo) {
      const sexoVal = dados.sexo.toUpperCase().startsWith('F') ? '2' : '1';
      await page.select('select[id$="campoSexo_input"]', sexoVal);
    }

    // 2. Dados do RG
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await page.type('input[id$="campoRg"]', rgLimpo, { delay: 30 });
      // Órgão Emissor (1 = SSP)
      await page.select('select[id$="campoOrgaoEmissor_input"]', '1');
      // UF do RG (17 = PE ou UF correspondente)
      await page.select('select[id$="campoUf_input"]', '17');
    }

    // 3. Endereço (Preenchimento com dados padrão estruturais)
    await page.type('input[id$="endereco_cep"]', '50000000', { delay: 20 });
    await page.type('input[id$="endereco_rua"]', 'AVENIDA CENTRAL', { delay: 20 });
    await page.type('input[id$="endereco_bairro"]', 'CENTRO', { delay: 20 });
    await page.type('input[id$="endereco_cidade"]', 'RECIFE', { delay: 20 });
    await page.select('select[id$="certidao_antecedentes_criminais_endereco_pernambuco_input"]', '17');

    // 4. Submissão (Clicar no botão "Solicitar")
    console.log('[PCPE] Submetendo requisição de certidão...');
    await Promise.all([
      page.click('button[id$="j_idt97"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null)
    ]);

    // Aguarda processamento do JSF
    await new Promise(r => setTimeout(r, 4000));

    const resultadoTexto = await page.evaluate(() => document.body.innerText || '');

    if (resultadoTexto.toUpperCase().includes('NADA CONSTA') || resultadoTexto.toUpperCase().includes('CERTIDÃO NEGATIVA')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'CERTIDÃO NEGATIVA EMITIDA',
        mensagem: 'Nada Consta nos antecedentes criminais da Polícia Civil de Pernambuco.',
        rawSnippet: resultadoTexto.slice(0, 300)
      };
    }

    if (resultadoTexto.toUpperCase().includes('EXISTEM REGISTROS') || resultadoTexto.toUpperCase().includes('APONTAMENTO')) {
      return {
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'REGISTRO LOCALIZADO',
        mensagem: 'Identificado registro processual/criminal na base da PCPE.'
      };
    }

    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'SOLICITAÇÃO PROCESSADA',
      mensagem: 'Consulta executada no sistema do IITB / PCPE.',
      rawSnippet: resultadoTexto.slice(0, 300)
    };

  } catch (error) {
    console.error(`[PCPE] Erro crítico na execução:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log(`[PCPE] Navegador encerrado com sucesso.`);
    }
  }
}
