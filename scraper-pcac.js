/**
 * Scraper / Conector Oficial - Polícia Civil do Estado do Acre (PCAC)
 * Portal: https://idpol.ac.gov.br/services/EmitirAAC
 * Endpoint Oficial iDSPS: https://idpol.ac.gov.br/Vsoft.iDSPS.API/api/atestadoantecedentes/gerar
 * 
 * Compatível com Node.js 18+ / 24+ (ES Modules)
 */

const ORGAO_EMISSOR = 'Polícia Civil do Estado do Acre (PCAC)';
const SCRIPT_NAME = 'scraper-pcac.js';
const URL_PORTAL = 'https://idpol.ac.gov.br/services/EmitirAAC';
const URL_API_GERAR = 'https://idpol.ac.gov.br/Vsoft.iDSPS.API/api/atestadoantecedentes/gerar';

/**
 * Converte data de nascimento para o formato esperado pela API da PCAC (MM-DD-YYYY)
 * @param {string} rawDate - Data em DD/MM/YYYY ou YYYY-MM-DD
 * @returns {string} - Data formatada em MM-DD-YYYY
 */
function formatarDataParaApi(rawDate) {
  if (!rawDate) return '';
  const clean = String(rawDate).trim();
  
  // DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) {
    const [dia, mes, ano] = clean.split('/');
    return `${mes}-${dia}-${ano}`;
  }
  
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const [ano, mes, dia] = clean.split('-');
    return `${mes}-${dia}-${ano}`;
  }
  
  return clean;
}

/**
 * Formata CPF com pontuação padrão (000.000.000-00) exigida pela máscara da PCAC
 * @param {string} rawCpf
 * @returns {string}
 */
function formatarCpfMascara(rawCpf) {
  if (!rawCpf) return '';
  const digits = String(rawCpf).replace(/\D/g, '');
  if (digits.length === 11) {
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
  return rawCpf;
}

/**
 * Executa a consulta de antecedentes criminais na PCAC
 * Aceita tanto consultarAntecedentesPCAC(dados) quanto consultarAntecedentesPCAC(browser, dados)
 */
export async function consultarAntecedentesPCAC(param1, param2) {
  // Tratamento polimórfico de assinatura (com ou sem browser injetado)
  const isBrowser = param1 && typeof param1.newPage === 'function';
  const browser = isBrowser ? param1 : null;
  const rawParams = isBrowser ? param2 : param1;
  const dados = (rawParams && rawParams.dados) ? rawParams.dados : (rawParams || {});

  const nome = (dados.nome || '').trim().toUpperCase();
  const cpfComMascara = formatarCpfMascara(dados.cpf || '');
  const cpfDigitos = (dados.cpf || '').replace(/\D/g, '');
  const dataNascApi = formatarDataParaApi(dados.dataNascimento || '');
  const rg = (dados.rg || '').trim();
  const nomeMae = (dados.nomeMae || '').trim().toUpperCase();

  console.log(`[PCAC] Iniciando consulta para: ${nome} (CPF: ${cpfComMascara})`);

  if (!cpfDigitos) {
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'DADOS_INCOMPLETOS',
      mensagem: 'CPF é obrigatório para emissão de antecedentes na PCAC.',
      orgao_emissor: ORGAO_EMISSOR,
      script: SCRIPT_NAME,
      detalhes: []
    };
  }

  // ESTRATÉGIA 1: Chamada Direta à API Oficial da PCAC (Rápida, estável e imune a timeout de seletores)
  try {
    const apiPayload = {
      Rg: rg,
      Nome: nome,
      DataNascimento: dataNascApi,
      NomeMae: nomeMae,
      Cpf: cpfComMascara
    };

    console.log('[PCAC] Enviando payload para API oficial:', JSON.stringify(apiPayload));

    const response = await fetch(URL_API_GERAR, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': URL_PORTAL,
        'Origin': 'https://idpol.ac.gov.br'
      },
      body: JSON.stringify(apiPayload)
    });

    const status = response.status;
    const responseText = await response.text();
    console.log(`[PCAC] Resposta da API oficial (HTTP ${status}):`, responseText.slice(0, 300));

    // CENÁRIO A: HTTP 200 - Registros retornados (Array JSON)
    if (status === 200) {
      let registros = [];
      try {
        registros = JSON.parse(responseText);
      } catch (e) {
        registros = [];
      }

      if (Array.isArray(registros) && registros.length > 0) {
        const primeiro = registros[0];
        const hasCriminal = Boolean(primeiro.HasCriminal);

        if (!hasCriminal) {
          // Nada Consta Emitido!
          const pdfUrl = `${URL_API_GERAR}?rg=${encodeURIComponent(primeiro.Rg || rg)}&nome=${encodeURIComponent(primeiro.Nome || nome)}&dataNascimento=${encodeURIComponent(primeiro.DataNascimento || dataNascApi)}&nomeMae=${encodeURIComponent(primeiro.NomeMae || nomeMae)}&nomePai=${encodeURIComponent(primeiro.NomePai || '')}&cpf=${encodeURIComponent(primeiro.Cpf || cpfComMascara)}&hasCriminal=false&oid=${encodeURIComponent(primeiro.OidAtestado || '')}`;

          return {
            sucesso: true,
            hasRecords: false,
            statusTexto: 'NADA_CONSTA',
            mensagem: 'Certidão Negativa de Antecedentes Criminais emitida com sucesso.',
            certidaoUrl: pdfUrl,
            orgao_emissor: ORGAO_EMISSOR,
            script: SCRIPT_NAME,
            rawSnippet: `Certidão PCAC emitida. OID: ${primeiro.OidAtestado || 'Oficial'}`,
            detalhes: [
              {
                orgao: ORGAO_EMISSOR,
                data: new Date().toLocaleDateString('pt-BR'),
                descricao: `Certidão Negativa de Antecedentes Criminais gerada pelo portal oficial da PCAC para ${primeiro.Nome || nome}.`
              }
            ]
          };
        } else {
          // Constam Apontamentos Criminais
          return {
            sucesso: true,
            hasRecords: true,
            statusTexto: 'APONTAMENTOS_LOCALIZADOS',
            mensagem: 'Constam registros/apontamentos nos arquivos do Instituto de Identificação da PCAC.',
            orgao_emissor: ORGAO_EMISSOR,
            script: SCRIPT_NAME,
            rawSnippet: 'Não foi possível emitir nada consta para os dados fornecidos. Consta registro criminal.',
            detalhes: [
              {
                orgao: ORGAO_EMISSOR,
                data: new Date().toLocaleDateString('pt-BR'),
                descricao: 'Apontamento criminal localizado nos registros estaduais do Acre. Comparecimento presencial requerido.'
              }
            ]
          };
        }
      }
    }

    // CENÁRIO B: HTTP 301 - Cidadão sem cadastro biométrico prévio no Estado do Acre
    if (status === 301 || responseText.includes('Não foi encontrado nenhum regitro') || responseText.includes('EmitirNC/Confirmacao')) {
      return {
        sucesso: true,
        hasRecords: false,
        statusTexto: 'REGISTRO_NAO_ENCONTRADO',
        mensagem: 'Não foi localizado registro biométrico civil prévio no Estado do Acre. Emissão on-line restrita à base cadastrada.',
        orgao_emissor: ORGAO_EMISSOR,
        script: SCRIPT_NAME,
        rawSnippet: 'Não foi encontrado nenhum registro no banco de dados da PCAC. Dirija-se ao Instituto para emissão presencial.',
        detalhes: [
          {
            orgao: ORGAO_EMISSOR,
            data: new Date().toLocaleDateString('pt-BR'),
            descricao: 'Cidadão sem prontuário de identificação civil cadastrado no Instituto de Identificação da Polícia Civil do Acre.'
          }
        ]
      };
    }

    // CENÁRIO C: HTTP 400 - Dados divergentes da Receita Federal
    if (status === 400) {
      let cleanMsg = responseText.replace(/^"|"$/g, '').trim();
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'DADOS_DIVERGENTES',
        mensagem: cleanMsg || 'Os dados informados não conferem com o cadastro oficial da Receita Federal.',
        error: cleanMsg,
        orgao_emissor: ORGAO_EMISSOR,
        script: SCRIPT_NAME,
        detalhes: []
      };
    }
  } catch (apiError) {
    console.warn('[PCAC] Falha na chamada da API direta, tentando fallback:', apiError.message);
  }

  // ESTRATÉGIA 2: Fallback com Puppeteer (apenas se a API direta falhar e o browser estiver disponível)
  if (browser) {
    let page = null;
    try {
      console.log('[PCAC] Executando fallback via Puppeteer...');
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1280, height: 800 });

      // Timeout amplo e waitUntil mais permissivo para evitar travar no IIS
      await page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded', timeout: 35000 });

      // Verifica se a página atual é a do formulário ou se caiu no menu
      const currentUrl = page.url();
      if (!currentUrl.includes('EmitirAAC')) {
        console.log('[PCAC] Redirecionado para menu. Navegando para EmitirAAC...');
        await page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      }

      // Procura o seletor com tolerância
      const inputNome = await page.waitForSelector('#nome, input#nome, input[name="nome"]', { timeout: 12000 }).catch(() => null);

      if (inputNome) {
        if (rg) await page.type('#rg', rg);
        await page.type('#nome', nome);
        if (dados.dataNascimento) {
          const dtFormatada = dados.dataNascimento.includes('-') 
            ? dados.dataNascimento.split('-').reverse().join('/') 
            : dados.dataNascimento;
          await page.type('#dataNascimento', dtFormatada);
        }
        await page.type('#cpf', cpfComMascara);
        if (nomeMae) await page.type('#mae', nomeMae);

        await Promise.all([
          page.click('#btEmitir').catch(() => {}),
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {})
        ]);

        const bodyContent = await page.content();
        if (bodyContent.includes('Não foi encontrado nenhum regitro') || page.url().includes('Confirmacao')) {
          return {
            sucesso: true,
            hasRecords: false,
            statusTexto: 'REGISTRO_NAO_ENCONTRADO',
            mensagem: 'Não foi encontrado registro biométrico no Estado do Acre.',
            orgao_emissor: ORGAO_EMISSOR,
            script: SCRIPT_NAME,
            detalhes: []
          };
        }
      }
    } catch (puppetErr) {
      console.error('[PCAC] Falha no fallback do Puppeteer:', puppetErr.message);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // Retorno caso nenhuma estratégia obtenha resposta
  return {
    sucesso: false,
    hasRecords: false,
    statusTexto: 'FALHA_CONSULTA',
    mensagem: 'Falha temporária de comunicação com o portal da PCAC.',
    error: 'Não foi possível completar a consulta no portal da PCAC.',
    orgao_emissor: ORGAO_EMISSOR,
    script: SCRIPT_NAME,
    detalhes: []
  };
}

// Aliases para máxima compatibilidade com o router do Render
export const consultarPCAC = consultarAntecedentesPCAC;
export default consultarAntecedentesPCAC;
