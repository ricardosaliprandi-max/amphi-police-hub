import express from 'express';
import cors from 'cors';
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

// Health check para manter o Render acordado
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'amphi-police-hub' });
});

// 1. Rota Legada (Garante 100% de compatibilidade com a bancada AMPHI atual)
app.post('/api/pces/antecedentes', async (req, res) => {
  try {
    const dados = req.body;
    console.log('[HUB] Consulta PCES via rota direta:', dados.nome);
    const resultado = await consultarAntecedentesPCES(dados);
    res.json(resultado);
  } catch (error) {
    console.error('[HUB] Erro na consulta PCES:', error);
    res.status(500).json({
      sucesso: false,
      hasRecords: false,
      statusTexto: 'ERRO NA CONSULTA PCES',
      mensagem: error.message
    });
  }
});

// 2. NOVA ROTA: Consulta em Lote / Paralela (Dispara TODAS as UFs de uma vez)
app.post('/api/v1/todos/antecedentes', async (req, res) => {
  const dados = req.body;
  console.log('[HUB] Iniciando varredura em lote para TODAS as UFs para:', dados.nome);

  try {
    // Dispara todos os scrapers mapeados em paralelo de forma blindada
    const promessas = [
      consultarAntecedentesPCES(dados).then(r => ({ uf: 'es', ...r })).catch(e => ({ uf: 'es', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCAC(dados).then(r => ({ uf: 'ac', ...r })).catch(e => ({ uf: 'ac', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCAL(dados).then(r => ({ uf: 'al', ...r })).catch(e => ({ uf: 'al', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCCE(dados).then(r => ({ uf: 'ce', ...r })).catch(e => ({ uf: 'ce', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCMA(dados).then(r => ({ uf: 'ma', ...r })).catch(e => ({ uf: 'ma', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCMS(dados).then(r => ({ uf: 'ms', ...r })).catch(e => ({ uf: 'ms', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCPA(dados).then(r => ({ uf: 'pa', ...r })).catch(e => ({ uf: 'pa', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCPB(dados).then(r => ({ uf: 'pb', ...r })).catch(e => ({ uf: 'pb', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCPE(dados).then(r => ({ uf: 'pe', ...r })).catch(e => ({ uf: 'pe', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCRN(dados).then(r => ({ uf: 'rn', ...r })).catch(e => ({ uf: 'rn', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCRR(dados).then(r => ({ uf: 'rr', ...r })).catch(e => ({ uf: 'rr', sucesso: false, mensagem: e.message })),
      consultarAntecedentesPCSC(dados).then(r => ({ uf: 'sc', ...r })).catch(e => ({ uf: 'sc', sucesso: false, mensagem: e.message }))
    ];

    const resultadosAutomaticos = await Promise.all(promessas);

    // Estados com barreiras técnicas tratados institucionalmente
    const resultadosInstitucionais = [
      { uf: 'go', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige resolução de Captcha e fluxo multi-fases.' },
      { uf: 'mg', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige validação por Captcha visual interno.' },
      { uf: 'df', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige confirmação de código OTP enviado por e-mail.' },
      { uf: 'ap', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Fluxo restrito ao atendimento presencial.' },
      { uf: 'am', sucesso: false, canalInstitucional: true, hasRecords: false, statusTexto: 'CANAL INSTITUCIONAL', mensagem: 'Exige fluxo próprio autenticado na base local.' }
    ];

    const resultadosUFs = [...resultadosAutomaticos, ...resultadosInstitucionais];
    const geral_nada_consta = resultadosUFs.every(r => (r.sucesso && !r.hasRecords) || r.canalInstitucional);

    return res.json({
      sucesso: true,
      geral_nada_consta,
      resultadosUFs
    });

  } catch (error) {
    console.error('[HUB] Erro na varredura em lote geral:', error);
    return res.status(500).json({
      sucesso: false,
      mensagem: error.message
    });
  }
});

// 3. Rota Unificada Individual (Mantida para testes estado por estado)
app.post('/api/v1/:uf/antecedentes', async (req, res) => {
  const uf = req.params.uf.toLowerCase().trim();
  const dados = req.body;

  console.log(`[HUB] Requisição multi-estado recebida para UF: ${uf.toUpperCase()}`);

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
  console.log(`AMPHI Police Scraper Hub ativo na porta ${PORT}`);
});
