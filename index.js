import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/api/pces/antecedentes', async (req, res) => {
  const { 
    tipoDocumento, 
    rg, 
    uf, 
    nome, 
    nomePai, 
    nomeMae, 
    dataNascimento 
  } = req.body;

  // Validação dos campos obrigatórios
  if (!rg || !nome || !nomeMae || !dataNascimento) {
    return res.status(400).json({ 
      error: 'Campos obrigatórios ausentes: rg, nome, nomeMae e dataNascimento são exigidos.' 
    });
  }

  const cleanRg = rg.replace(/\D/g, '');
  const cleanNome = nome.trim().toUpperCase();
  const cleanPai = nomePai ? nomePai.trim().toUpperCase() : 'NAO DECLARADO';
  const cleanMae = nomeMae.trim().toUpperCase();
  const selectedUf = uf ? uf.trim().toUpperCase() : 'ES';
  const docType = tipoDocumento ? tipoDocumento.trim().toUpperCase() : 'RG';

  let browser = null;

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
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 1. Navega até o portal oficial da SESP/PCES (JSF)
    await page.goto('https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf', {
      waitUntil: 'networkidle2',
      timeout: 35000
    });

    // 2. Preenche os campos do formulário JSF
    await page.evaluate((type) => {
      const selectDoc = document.querySelector('select[id*="tipoDoc"], select[id*="Documento"], select[name*="Documento"]');
      if (selectDoc) {
        selectDoc.value = type;
        selectDoc.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, docType).catch(() => {});

    await page.waitForSelector('input[id*="numDoc"], input[id*="rg"], input[id*="Num"]', { timeout: 10000 });
    await page.type('input[id*="numDoc"], input[id*="rg"], input[id*="Num"]', cleanRg);

    await page.evaluate((targetUf) => {
      const selectUf = document.querySelector('select[id*="ufDoc"], select[id*="uf"], select[name*="uf"]');
      if (selectUf) {
        selectUf.value = targetUf;
        selectUf.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selectedUf).catch(() => {});

    await page.type('input[id*="nomePessoa"], input[id*="nome"]', cleanNome);
    await page.type('input[id*="nomePai"], input[id*="pai"]', cleanPai);
    await page.type('input[id*="nomeMae"], input[id*="mae"]', cleanMae);
    await page.type('input[id*="dtNasc"], input[id*="dataNasc"], input[id*="nascimento"]', dataNascimento);

    // 3. Submete o formulário JSF
    await Promise.all([
      page.click('input[type="submit"], button[type="submit"], input[value*="Emitir"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {})
    ]);

    // 4. Analisa a resposta da página
    const content = await page.content();
    const contentUpper = content.toUpperCase();

    // Validação estrita do Atestado Negativo Emitido
    const atestadoEmitidoComSucesso = 
      contentUpper.includes('NADA CONSTA CONTRA') || 
      (contentUpper.includes('ATESTO QUE') && contentUpper.includes('NADA CONSTA'));

    if (atestadoEmitidoComSucesso) {
      return res.json({
        fonte: 'SESP_PCES',
        rg: cleanRg,
        uf: selectedUf,
        nome: cleanNome,
        sucesso: true,
        hasRecords: false,
        riskLevel: 'LOW',
        statusTexto: 'NADA CONSTA',
        mensagem: 'Certidão negativa emitida com sucesso.',
        executedAt: new Date().toISOString()
      });
    } else {
      // Retorno focado em Alerta de Risco para o RH
      return res.json({
        fonte: 'SESP_PCES',
        rg: cleanRg,
        uf: selectedUf,
        nome: cleanNome,
        sucesso: true,
        hasRecords: true,
        riskLevel: 'HIGH',
        statusTexto: 'NÃO FOI POSSÍVEL EMITIR CERTIDÃO NEGATIVA',
        mensagem: 'ATENÇÃO: Possível apontamento ou pendência cadastral registrada na Polícia Civil. Recomendada validação minuciosa.',
        executedAt: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('Erro na automação da SESP-ES:', error.message);

    return res.status(500).json({
      fonte: 'SESP_PCES',
      sucesso: false,
      hasRecords: true,
      riskLevel: 'HIGH',
      statusTexto: 'NÃO FOI POSSÍVEL EMITIR CERTIDÃO NEGATIVA',
      error: 'O portal da SESP-ES demorou para responder ou impediu a emissão.',
      details: error.message
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Microserviço SESP/PCES rodando na porta ${PORT}`);
});
