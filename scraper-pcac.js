/**
 * scraper-pcac.js
 * Robô de automação para emissão/consulta de Antecedentes Criminais
 * Órgão: Polícia Civil do Estado do Acre (PCAC / IDPOL / Vsoft)
 * Portal: https://idpol.ac.gov.br/services/
 */

const puppeteer = require('puppeteer');

/**
 * Função utilitária para formatar data para o padrão do formulário (DD/MM/AAAA)
 */
function formatarDataNascimento(dataStr) {
  if (!dataStr) return '';
  const limpa = String(dataStr).trim();
  // Se estiver em formato ISO AAAA-MM-DD
  if (limpa.includes('-')) {
    const partes = limpa.split('-');
    if (partes.length === 3 && partes[0].length === 4) {
      return `${partes[2].padStart(2, '0')}/${partes[1].padStart(2, '0')}/${partes[0]}`;
    }
  }
  // Se já for DD/MM/AAAA
  if (limpa.includes('/')) {
    return limpa;
  }
  // Se for apenas números DDMMAAAA
  const apenasNumeros = limpa.replace(/\D/g, '');
  if (apenasNumeros.length === 8) {
    return `${apenasNumeros.slice(0, 2)}/${apenasNumeros.slice(2, 4)}/${apenasNumeros.slice(4)}`;
  }
  return limpa;
}

/**
 * Função utilitária para formatar CPF com pontuação (000.000.000-00)
 */
function formatarCpf(cpfStr) {
  const limpo = String(cpfStr || '').replace(/\D/g, '');
  if (limpo.length === 11) {
    return `${limpo.slice(0, 3)}.${limpo.slice(3, 6)}.${limpo.slice(6, 9)}-${limpo.slice(9, 11)}`;
  }
  return limpo;
}

/**
 * Executa a automação de consulta na PCAC
 * @param {Object} payload Objeto recebido com { dados: { nome, cpf, dataNascimento, nomeMae, rg, ... } }
 * @returns {Promise<Object>} Resposta padronizada da checagem
 */
async function consultarPCAC(payload) {
  const dados = payload?.dados || payload || {};
  const nome = String(dados.nome || '').trim().toUpperCase();
  const cpfFormatado = formatarCpf(dados.cpf);
  const dataNascFormatada = formatarDataNascimento(dados.dataNascimento);
  const nomeMae = String(dados.nomeMae || dados.mae || '').trim().toUpperCase();
  const rg = String(dados.rg || '').trim().toUpperCase();

  const urlAlvo = 'https://idpol.ac.gov.br/services/AtestadoAntecedentes/Emitir';
  const urlFallback = 'https://idpol.ac.gov.br/services/';

  let browser = null;

  try {
    console.log(`>> [PCAC] Iniciando varredura para: ${nome} (CPF: ${cpfFormatado})`);

    browser = await puppeteer.launch({
      headless: 'new', // ou true
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Configura headers e viewport realistas
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Variável para capturar respostas diretas da API interna da Vsoft
    let apiInterceptedData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('Vsoft.iDSPS.API/api') || url.includes('/Emitir') || url.includes('/Validar')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            apiInterceptedData = await response.json();
            console.log('>> [PCAC] Resposta da API interceptada com sucesso:', JSON.stringify(apiInterceptedData).slice(0, 150));
          }
        } catch (_) {}
      }
    });

    // 1. Navega para a página de emissão
    try {
      await page.goto(urlAlvo, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch {
      console.warn('>> [PCAC] Rota direta falhou, tentando rota raiz /services/ ...');
      await page.goto(urlFallback, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    // 2. Se caiu na tela inicial com botão/link de antecedentes, clica para entrar
    const linkEmitir = await page.$('a[href*="Antecedentes"], a[href*="Atestado"]');
    if (linkEmitir) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        linkEmitir.click(),
      ]);
    }

    // 3. Localiza os campos com waitForSelector explícito
    console.log('>> [PCAC] Aguardando campo #nome no formulário...');
    await page.waitForSelector('input#nome', { visible: true, timeout: 20000 });

    // 4. Preenchimento seguro dos campos disparando eventos do Vue.js
    // RG (se informado)
    if (rg) {
      await page.type('input#rg', rg, { delay: 25 });
    }

    // Nome Completo
    await page.click('input#nome');
    await page.type('input#nome', nome, { delay: 30 });
    await page.evaluate(() => {
      const el = document.querySelector('input#nome');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Data de Nascimento
    await page.click('input#dataNascimento');
    await page.type('input#dataNascimento', dataNascFormatada, { delay: 30 });
    await page.evaluate(() => {
      const el = document.querySelector('input#dataNascimento');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // CPF
    await page.click('input#cpf');
    await page.type('input#cpf', cpfFormatado, { delay: 30 });
    await page.evaluate(() => {
      const el = document.querySelector('input#cpf');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Nome da Mãe (campo é input#mae)
    if (nomeMae) {
      await page.click('input#mae');
      await page.type('input#mae', nomeMae, { delay: 30 });
      await page.evaluate(() => {
        const el = document.querySelector('input#mae');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    console.log('>> [PCAC] Campos preenchidos. Submetendo formulário...');

    // 5. Clica no botão Emitir (#btEmitir)
    await page.waitForSelector('#btEmitir', { visible: true });
    await Promise.all([
      page.click('#btEmitir'),
      // Aguarda requisições AJAX ou carregamento do modal/resposta
      page.waitForNetworkIdle({ idleTime: 1000, timeout: 25000 }).catch(() => {}),
    ]);

    // Pausa breve para o Vue processar o modal ou download
    await new Promise((r) => setTimeout(r, 3000));

    // 6. Análise dos Resultados
    const resultadoTexto = await page.evaluate(() => {
      // Verifica se abriu o modal de múltiplos registros
      const tabela = document.querySelector('#corpoTabelaModalResultados');
      const modalVisivel = document.querySelector('#modalResultados.in, #modalResultados[style*="display: block"]');
      const tabelaTemLinhas = tabela && tabela.querySelectorAll('tr').length > 0;

      // Verifica alertas na tela
      const msgNadaConsta = document.querySelector('#MsgNadaConstaQuandoTemAntCrim');
      const alerta = document.querySelector('.alert, .has-error, .help-block');

      return {
        modalVisivel: Boolean(modalVisivel || tabelaTemLinhas),
        linhasTabela: tabelaTemLinhas ? tabela.querySelectorAll('tr').length : 0,
        textoAlerta: alerta ? alerta.innerText.trim() : '',
        msgNadaConsta: msgNadaConsta ? msgNadaConsta.innerText.trim() : '',
        bodyText: document.body.innerText,
      };
    });

    // 7. Interpretação das regras da certidão
    const temApontamento =
      resultadoTexto.modalVisivel ||
      resultadoTexto.linhasTabela > 0 ||
      resultadoTexto.bodyText.toUpperCase().includes('CONSTA') ||
      resultadoTexto.bodyText.toUpperCase().includes('PROCESSO') ||
      (apiInterceptedData && apiInterceptedData.temAntecedente === true);

    const isErroValidacao =
      resultadoTexto.textoAlerta.includes('inválido') ||
      resultadoTexto.textoAlerta.includes('obrigatório');

    if (isErroValidacao) {
      return {
        sucesso: false,
        hasRecords: false,
        statusTexto: 'ERRO_VALIDACAO',
        orgao_emissor: 'Polícia Civil do Estado do Acre (PCAC)',
        mensagem: resultadoTexto.textoAlerta || 'Dados informados não passaram na validação do portal da PCAC.',
      };
    }

    if (temApontamento) {
      return {
        sucesso: true,
        hasRecords: true,
        statusTexto: 'APONTAMENTO LOCALIZADO',
        orgao_emissor: 'Polícia Civil do Estado do Acre (PCAC)',
        portal: 'Portal de Serviços da Polícia Civil do Acre (IDPOL / Vsoft)',
        mensagem: 'Localizado registro de antecedentes criminais ou multiplicidade cadastral na base da Polícia Civil do Acre.',
        certidaoUrl: page.url(),
      };
    }

    // Caso padrão: Certidão Negativa / Nada Consta
    return {
      sucesso: true,
      hasRecords: false,
      statusTexto: 'NADA CONSTA',
      orgao_emissor: 'Polícia Civil do Estado do Acre (PCAC)',
      portal: 'Portal de Serviços da Polícia Civil do Acre (IDPOL / Vsoft)',
      mensagem: 'Certidão Negativa de Antecedentes Criminais gerada com sucesso na base oficial da PCAC.',
      certidaoUrl: page.url(),
    };
  } catch (err) {
    console.error('>> [PCAC] Erro ao executar scraper:', err.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCAC',
      orgao_emissor: 'Polícia Civil do Estado do Acre (PCAC)',
      mensagem: `Falha na consulta ao portal da PCAC: ${err.message}`,
      error: err.message,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// Exporta para ser usado pela rota /api/v1/ac/antecedentes do Express no Render
module.exports = {
  consultarPCAC,
};
