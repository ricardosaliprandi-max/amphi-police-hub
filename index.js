import express from 'express';
import cors from 'cors';
import { consultarAntecedentesPCES } from './scraper-pces.js';

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

// 2. Rota Unificada Multi-Estados (Pronta para plugar novos estados: SP, MG, RJ, etc.)
app.post('/api/v1/:uf/antecedentes', async (req, res) => {
  const uf = req.params.uf.toLowerCase();
  const dados = req.body;

  console.log(`[HUB] Requisição multi-estado recebida para UF: ${uf.toUpperCase()}`);

  try {
    switch (uf) {
      case 'es': {
        const resultado = await consultarAntecedentesPCES(dados);
        return res.json(resultado);
      }

      // Os novos estados entram aqui quando criarmos os arquivos:
      // case 'sp': {
      //   const resultado = await consultarAntecedentesPCSP(dados);
      //   return res.json(resultado);
      // }

      default:
        return res.status(400).json({
          sucesso: false,
          hasRecords: false,
          statusTexto: 'ESTADO NÃO SUPORTADO',
          mensagem: `O orquestrador ainda não possui scraper ativo para o estado '${uf.toUpperCase()}'.`
        });
    }
  } catch (error) {
    console.error(`[HUB] Erro na consulta [${uf.toUpperCase()}]:`, error);
    return res.status(500).json({
      sucesso: false,
      hasRecords: false,
      statusTexto: `ERRO NA CONSULTA PC${uf.toUpperCase()}`,
      mensagem: error.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AMPHI Police Scraper Hub ativo na porta ${PORT}`);
});
