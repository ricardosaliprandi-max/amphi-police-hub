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

    // Aguarda o formulário JSF ou qualquer input carregar de forma flexível
    await page.waitForSelector('form, input', { timeout: 15000 }).catch(() => {});

    // Função auxiliar segura para preencher campos por seletor parcial do JSF
    async function preencherCampo(seletorSufixo, valor, delay = 30) {
      if (!valor) return;
      const seletores = [`input[id$="${seletorSufixo}"]`, `input[name*="${seletorSufixo}" i]`, `input[id*="${seletorSufixo}" i]`];
      for (const sel of seletores) {
        try {
          const el = await page.$(sel);
          if (el) {
            await page.focus(sel);
            await page.evaluate(s => document.querySelector(s).value = '', sel);
            await page.type(sel, String(valor), { delay });
            return true;
          }
        } catch (e) {
          // Tenta o próximo
        }
      }
      return false;
    }

    // Função auxiliar segura para selects PrimeFaces
    async function selecionarCampo(seletorSufixo, valorOpcao) {
      if (!valorOpcao) return;
      const seletores = [`select[id$="${seletorSufixo}"]`, `select[id*="${seletorSufixo}" i]`];
      for (const sel of seletores) {
        try {
          const el = await page.$(sel);
          if (el) {
            await page.select(sel, String(valorOpcao)).catch(() => {});
            return true;
          }
        } catch (e) {
          // Tenta o próximo
        }
      }
      return false;
    }

    // 1. Dados Pessoais
    await preencherCampo('campoNome', dados.nome.toUpperCase().trim(), 30);
    
    if (dados.nomeMae) {
      await preencherCampo('campoNomeMae', dados.nomeMae.toUpperCase().trim(), 30);
    }
    if (dados.nomePai && !dados.nomePai.toUpperCase().includes('DECLARADO')) {
      await preencherCampo('campoNomePai', dados.nomePai.toUpperCase().trim(), 30);
    }

    // Profissão
    const profissao = dados.profissao || 'AUTONOMO';
    await preencherCampo('campoProfissao', profissao.toUpperCase(), 20);

    // Nacionalidade e Naturalidade
    await preencherCampo('campoNacionalidade', 'BRASILEIRA', 20);
    const naturalidade = dados.naturalidade || 'RECIFE';
    await preencherCampo('campoNaturalidade', naturalidade.toUpperCase(), 20);

    // UF Naturalidade e Estado Civil
    await selecionarCampo('campoUfNaturalidade_input', '17');
    await selecionarCampo('campoEstadoCivil_input', '1');

    // Data de Nascimento (DD/MM/AAAA)
    let dataNascFormatada = dados.dataNascimento || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dataNascFormatada)) {
      const [ano, mes, dia] = dataNascFormatada.split('-');
      dataNascFormatada = `${dia}/${mes}/${ano}`;
    }
    await preencherCampo('campoDataNascimento_input', dataNascFormatada, 30);

    // CPF
    const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');
    await preencherCampo('campoCpf', cpfLimpo, 30);

    // Sexo
    if (dados.sexo) {
      const sexoVal = dados.sexo.toUpperCase().startsWith('F') ? '2' : '1';
      await selecionarCampo('campoSexo_input', sexoVal);
    }

    // 2. Dados do RG
    const rgLimpo = String(dados.rg || dados.numero || '').replace(/\D/g, '');
    if (rgLimpo) {
      await preencherCampo('campoRg', rgLimpo, 30);
      await selecionarCampo('campoOrgaoEmissor_input', '1');
      await selecionarCampo('campoUf_input', '17');
    }

    // 3. Endereço (Preenchimento padrão estrutural)
    await preencherCampo('endereco_cep', '50000000', 20);
    await preencherCampo('endereco_rua', 'AVENIDA CENTRAL', 20);
    await preencherCampo('endereco_bairro', 'CENTRO', 20);
    await preencherCampo('endereco_cidade', 'RECIFE', 20);
    await selecionarCampo('certidao_antecedentes_criminais_endereco_pernambuco_input', '17');

    // 4. Submissão segura (Clicar no botão de solicitação)
    console.log('[PCPE] Submetendo requisição de certidão...');
    const botaoClicado = await page.evaluate(() => {
      const btn = document.querySelector('button[id$="j_idt97"], button[type="submit"], input[type="submit"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!botaoClicado) {
      await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
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
