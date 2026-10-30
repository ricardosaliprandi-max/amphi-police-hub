import puppeteer from 'puppeteer';

export async function consultarAntecedentesPCRN(dados) {
  const URL_BASE = 'https://sinf2.policiacivil.rn.gov.br/siscert/Home/gerarDeclaracaoEmPDF';
  
  // Normalização dos dados de entrada
  const rawCpf = dados.candidateCpf || dados.cpf || '';
  const rawName = dados.candidateName || dados.nome || '';
  const cpfLimpo = String(rawCpf).replace(/\D/g, '');
  const nomeFormatado = String(rawName).toUpperCase().trim();

  // Monta a URL com os parâmetros GET exigidos pelo form do HTML da PCRN
  const urlFinal = `${URL_BASE}?nomeCompleto=${encodeURIComponent(nomeFormatado)}&cpf=${encodeURIComponent(cpfLimpo)}`;

  console.log(`[PCRN] Disparando requisição direta para o endpoint de PDF: ${urlFinal}`);

  try {
    let respostaApi = null;
    let tentativasRestantes = 3;

    while (tentativasRestantes > 0) {
      try {
        const fetchRes = await fetch(urlFinal, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/pdf,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': 'https://sinf2.policiacivil.rn.gov.br/siscert/Home/index'
          }
        });

        const contentType = fetchRes.headers.get('content-type') || '';
        const bodyText = await fetchRes.text();

        console.log(`[PCRN] Status HTTP: ${fetchRes.status} | Content-Type: ${contentType} | Tamanho do corpo: ${bodyText.length}`);

        // Se retornar PDF ou sucesso
        if (fetchRes.ok || contentType.includes('application/pdf')) {
          return {
            sucesso: true,
            hasRecords: false, // Por padrão, emissão bem-sucedida sem apontamentos gera a certidão negativa/declaração limpa
            riskLevel: 'LOW',
            statusTexto: 'DECLARAÇÃO / CERTIDÃO GERADA COM SUCESSO',
            mensagem: 'Declaração de antecedentes gerada com sucesso pela PCRN.',
            rawSnippet: `Endpoint respondeu com sucesso. Content-Type: ${contentType}`
          };
        }

        tentativasRestantes--;
        if (tentativasRestantes > 0) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        return {
          sucesso: false,
          hasRecords: false,
          statusTexto: 'FALHA NA RESPOSTA PCRN',
          mensagem: `O servidor da PCRN retornou status ${fetchRes.status}`,
          rawSnippet: bodyText.slice(0, 200)
        };

      } catch (netErr) {
        tentativasRestantes--;
        if (tentativasRestantes === 0) {
          throw new Error(`Erro de rede ao comunicar com a API da PCRN: ${netErr.message}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

  } catch (error) {
    console.error(`[PCRN] Erro crítico na execução:`, error.message);
    return {
      sucesso: false,
      hasRecords: false,
      statusTexto: 'FALHA NA EXECUÇÃO PCRN',
      mensagem: error.message
    };
  }
}
