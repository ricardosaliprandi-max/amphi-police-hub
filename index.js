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

// 2. Rota Unificada Multi-Estados (Orquestrador integrado para todas as UFs mapeadas)
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

      // Estados com barreiras de segurança tratados via Canal Institucional / Assistido
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
          mensagem: `A consulta online para ${uf.toUpperCase()} possui barreiras técnicas: ${barreiras[uf]}. A plataforma cuidará deste caso via resposta institucional.`
        });
      }

      default:
        return res.status(400).json({
          sucesso: false,
          hasRecords: false,
          statusTexto: 'ESTADO NÃO SUPORTADO',
          mensagem: `O orquestrador não possui scraper ativo ou regra cadastrada para o estado '${uf.toUpperCase()}'.`
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
