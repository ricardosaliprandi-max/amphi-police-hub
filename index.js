import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/api/pces/antecedentes', async (req, res) => {
  const { cpf, nome, rg } = req.body;

  if (!cpf && !rg) {
    return res.status(400).json({ error: 'É necessário informar ao menos CPF ou RG.' });
  }

  const cleanCpf = cpf ? cpf.replace(/\D/g, '') : '';
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

    // 1. Navega até o portal oficial da SESP/PCES (JSF)
    await page.goto('https://ssp.sesp.es.gov.br/rgantecedentes/xhtml/pesquisaantecedentes.jsf', {
      waitUntil: 'networkidle2',
      timeout: 35000
    });

    // 2. Preenche os campos do formulário JSF
    if (cleanCpf) {
      await page.waitForSelector('input[id*="cpf"]', { timeout: 10000 });
      await page.type('input[id*="cpf"]', cleanCpf);
    }

    if (nome) {
      await page.type('input[id*="nome"]', nome);
    }

    // 3. Submete o formulário JSF
    await Promise.all([
      page.click('input[type="submit"], button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 })
    ]);

    // 4. Analisa a resposta da página
    const content = await page.content();
    const temApontamento = (content.includes('CONSTA') || content.includes('REGISTRO')) && !content.includes('NADA CONSTA');
    const nadaConsta = content.includes('NADA CONSTA') || content.includes('Atestamos que');

    await browser.close();

    return res.json({
      fonte: 'SESP_PCES',
      cpf: cleanCpf,
      nome: nome || '',
      sucesso: true,
      hasRecords: temApontamento,
      statusTexto: nadaConsta ? 'NADA CONSTA' : (temApontamento ? 'APONTAMENTO ENCONTRADO' : 'CONSULTA REALIZADA'),
      executedAt: new Date().toISOString()
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('Erro na automação da SESP-ES:', error);

    return res.status(500).json({
      fonte: 'SESP_PCES',
      sucesso: false,
      error: 'O portal da SESP-ES demorou para responder ou exige campos adicionais.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Microserviço SESP/PCES rodando na porta ${PORT}`);
});