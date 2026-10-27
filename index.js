import express from 'express';
import cors from 'cors';

// Importação de todos os scrapers estaduais mapeados no Hub
import { consultarAntecedentesPCES } from './scraper-pces.js';
import { consultarAntecedentesPCAC } from './scraper-pcac.js';
import { consultarAntecedentesPCAL } from './scraper-pcal.js';
import { consultarAntecedentesPCCE } from './scraper-pcce.js';
import { consultarAntecedentesPCMA } from './scraper-pcma.js';
import { consultarAntecedentesPCMS } from './scraper-pcms.js';
import { consultarAntecedentesPCPA } from './scraper-pcpa.js';
import { consultarAntecedentesPCPB } from './scraper-pcpb.js';
import { consultarAntecedentesPCPE } from './scraper-pcpe.js';
import { consultarAntecedentesPCRN } from './scraper-pcrn.js';
import { consultarAntecedentesPCRR } from './scraper-pcrr.js';
import { consultarAntecedentesPCSC } from './scraper-pcsc.js';

const app = express();

app.use(cors());
app.use(express.json());

// Health check para manter o serviço acordado no Render
app.get('/', (req, res) => {
  return res.json({ status: 'online', service: 'amphi-police-hub' });
});

// 1. Rota Legada (Garante 100% de compatibilidade com a bancada AMPHI atual para o Espírito Santo)
app.post('/api/pces/antecedentes', async (req, res) => {
  try {
    const rawBody = req.body || {};
    const dados = rawBody.dados && typeof rawBody.dados === 'object' 
      ? { ...rawBody.dados, ...rawBody } 
      : rawBody;

    if (!dados.nome) {
      return res.status(400).json({ 
        sucesso: false, 
        mensagem: 'O campo "nome" é obrigatório no corpo JSON.' 
      });
    }

    console.log('[HUB] Consulta PCES via rota direta:', dados.nome);
    const resultado = await consultarAntecedentesPCES(dados);
    return res.json(resultado);

  } catch (error) {
    console.error('[HUB] Erro na consulta PCES:', error);
    return res.status(500).json({
      sucesso: false,
      hasRecords: false,
      statusTexto: 'ERRO NA CONSULTA PCES',
      mensagem: error.message
    });
  }
});

// 2. ROTA EM LOTE SELETIVA (Otimizada para varrer apenas os estados selecionados via checkbox pelo operador)
app.post('/api/v1/todos/antecedentes', async (req, res) => {
  const rawBody = req.body || {};
  const dados = rawBody.dados && typeof rawBody.dados === 'object' 
    ? { ...rawBody.dados, ...rawBody } 
    : rawBody;

  if (!dados.nome) {
    return res.status(400).json({
      sucesso: false,
      statusTexto: 'REQUISIÇÃO INVÁLIDA',
      mensagem: 'O corpo da requisição (JSON) está vazio ou não contém o campo "nome". Verifique se o Header "Content-Type: application/json" está configurado.'
    });
  }

  // Mapeamento geral de todos os scrapers automáticos ativos
  const scrapersMap = [
    { uf: 'es', fn: consultarAntecedentesPCES },
    { uf: 'ac', fn: consultarAntecedentesPCAC },
    { uf: 'al', fn: consultarAntecedentesPCAL },
    { uf: 'ce', fn: consultarAntecedentesPCCE },
    { uf: 'ma', fn: consultarAntecedentesPCMA },
    { uf: 'ms', fn: consultarAntecedentesPCMS },
    { uf: 'pa', fn: consultarAntecedentesPCPA },
    { uf: 'pb', fn: consultarAntecedentesPCPB },
    { uf: 'pe', fn: consultarAntecedentesPCPE },
    { uf: 'rn', fn: consultarAntecedentesPCRN },
    { uf: 'rr', fn: consultarAntecedentesPCRR },
    { uf: 'sc', fn: consultarAntecedentesPCSC }
  ];

  // Mapeamento geral de barreiras institucionais (estados sem automação web direta)
  const institucionalMap = [
    { uf: 'go', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige resolução de Captcha e fluxo multi-fases.' },
    { uf: 'mg', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige validação por Captcha visual interno.' },
    { uf: 'df', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige confirmação de código OTP enviado por e-mail.' },
    { uf: 'ap', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Fluxo restrito ao atendimento presencial.' },
    { uf: 'am', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige fluxo próprio autenticado na base local.' }
  ];

  // Identifica os estados marcados pelo operador (via array de checkboxes na requisição)
  const estadosFiltrados = rawBody.estados || dados.estados;
  let alvosScrapers = scrapersMap;
  let alvosInstitucionais = institucionalMap;

  if (Array.isArray(estadosFiltrados) && estadosFiltrados.length > 0) {
    const ufsDesejadas = estadosFiltrados.map(u => String(u).toLowerCase().trim());
    alvosScrapers = scrapersMap.filter(s => ufsDesejadas.includes(s.uf));
    alvosInstitucionais = institucionalMap.filter(i => ufsDesejadas.includes(i.uf));
  }

  const UFsAtivas = [...alvosScrapers.map(s => s.uf), ...alvosInstitucionais.map(i => i.uf)];
  console.log(`[HUB] Iniciando varredura seletiva para UFs [${UFsAtivas.join(', ').toUpperCase()}] para: ${dados.nome}`);

  try {
    const resultadosUFs = [];

    // Executa as consultas automáticas de forma estritamente sequencial com respiro de memória
    for (const item of alvosScrapers) {
      try {
        console.log(`[HUB] Consultando estado: ${item.uf.toUpperCase()}...`);
        const resultado = await item.fn(dados);
        resultadosUFs.push({ uf: item.uf, ...resultado });

        // Pausa estratégica de 1.5s entre estados para o Render consolidar a RAM
        await new Promise(r => setTimeout(r, 1500));
        if (global.gc) {
          global.gc();
        }
      } catch (error) {
        console.error(`[HUB] Erro na UF ${item.uf.toUpperCase()}:`, error.message);
        resultadosUFs.push({
          uf: item.uf,
          sucesso: false,
          hasRecords: false,
          statusTexto: 'FALHA NA EXECUÇÃO',
          mensagem: error.message
        });
      }
    }

    const todasUFs = [...resultadosUFs, ...alvosInstitucionais];
    const geral_nada_consta = todasUFs.every(r => (r.sucesso && !r.hasRecords) || r.canalInstitucional);

    return res.json({
      sucesso: true,
      geral_nada_consta,
      resultadosUFs: todasUFs
    });

  } catch (error) {
    console.error('[HUB] Erro crítico na varredura geral:', error);
    return res.status(500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

// 3. Rota Unificada Individual por Estado
app.post('/api/v1/:uf/antecedentes', async (req, res) => {
  const uf = req.params.uf.toLowerCase().trim();
  const rawBody = req.body || {};
  const dados = rawBody.dados && typeof rawBody.dados === 'object' 
    ? { ...rawBody.dados, ...rawBody } 
    : rawBody;

  if (!dados.nome) {
    return res.status(400).json({ 
      sucesso: false, 
      mensagem: 'O campo "nome" é obrigatório no corpo JSON.' 
    });
  }

  console.log(`[HUB] Requisição individual recebida para UF: ${uf.toUpperCase()}`);

  try {
    let resultado;
    switch (uf) {
      case 'es':
        resultado = await consultarAntecedentesPCES(dados);
        break;
      case 'ac':
        resultado = await consultarAntecedentesPCAC(dados);
        break;
      case 'al':
        resultado = await consultarAntecedentesPCAL(dados);
        break;
      case 'ce':
        resultado = await consultarAntecedentesPCCE(dados);
        break;
      case 'ma':
        resultado = await consultarAntecedentesPCMA(dados);
        break;
      case 'ms':
        resultado = await consultarAntecedentesPCMS(dados);
        break;
      case 'pa':
        resultado = await consultarAntecedentesPCPA(dados);
        break;
      case 'pb':
        resultado = await consultarAntecedentesPCPB(dados);
        break;
      case 'pe':
        resultado = await consultarAntecedentesPCPE(dados);
        break;
      case 'rn':
        resultado = await consultarAntecedentesPCRN(dados);
        break;
      case 'rr':
        resultado = await consultarAntecedentesPCRR(dados);
        break;
      case 'sc':
        resultado = await consultarAntecedentesPCSC(dados);
        break;
      case 'go':
      case 'mg':
      case 'df':
      case 'ap':
      case 'am': {
        const barreiras = {
          'go': 'Exige resolução de Captcha e fluxo multi-fases.',
          'mg': 'Exige validação por Captcha visual interno.',
          'df': 'Exige confirmação de código OTP enviado por e-mail.',
          'ap': 'Fluxo restrito ao atendimento presencial.',
          'am': 'Exige fluxo próprio autenticado na base local.'
        };
        return res.json({
          sucesso: false,
          canalInstitucional: true,
          uf: uf.toUpperCase(),
          statusTexto: 'CANAL INSTITUCIONAL / ASSISTIDO',
          mensagem: `A consulta online para ${uf.toUpperCase()} possui barreiras técnicas: ${barreiras[uf]}.`
        });
      }
      default:
        return res.status(400).json({
          sucesso: false,
          hasRecords: false,
          statusTexto: 'ESTADO NÃO SUPORTADO',
          mensagem: `O orquestrador não possui scraper ativo para o estado '${uf.toUpperCase()}'.`
        });
    }

    return res.json(resultado);

  } catch (error) {
    console.error(`[HUB] Erro na consulta [${uf.toUpperCase()}]:`, error);
    return res.status(500).json({
      sucesso: false,
      hasRecords: false,
      canalInstitucional: true,
      statusTexto: `ERRO NA CONSULTA PC${uf.toUpperCase()}`,
      mensagem: error.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[AMPHI Police Scraper Hub] Ativo e escutando na porta ${PORT}`);
});
