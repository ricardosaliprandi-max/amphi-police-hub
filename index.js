// 4. Analisa o resultado na página
    const content = await page.content();
    const contentUpper = content.toUpperCase();

    // Palavras-chave que indicam BLOQUEIO, IMPEDIMENTO ou NECESSIDADE DE DOCUMENTOS
    const temImpedimentoOuAlerta = 
      contentUpper.includes('ENVIAR DOCUMENTO') ||
      contentUpper.includes('SOLICITADO') ||
      contentUpper.includes('COMPARECER') ||
      contentUpper.includes('SETOR RESPONSÁVEL') ||
      contentUpper.includes('NÃO FOI POSSÍVEL') ||
      contentUpper.includes('DIVERGÊNCIA') ||
      contentUpper.includes('ATENDIMENTO PRESENCIAL') ||
      contentUpper.includes('IMPOSSIBILITADA');

    // Confirmação REAL de emissão (exige texto expresso de atestação E ausência de alertas)
    const atestadoGeradoComSucesso = 
      (contentUpper.includes('ATESTAMOS QUE') || contentUpper.includes('CERTIDÃO NEGATIVA EMITIDA')) &&
      !temImpedimentoOuAlerta;

    if (atestadoGeradoComSucesso) {
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
      // Qualquer impedimento, mensagem de envio de documento ou alerta cai aqui
      return res.json({
        fonte: 'SESP_PCES',
        rg: cleanRg,
        uf: selectedUf,
        nome: cleanNome,
        sucesso: true,
        hasRecords: true,
        riskLevel: 'MEDIUM',
        statusTexto: 'NÃO FOI POSSÍVEL EMITIR CERTIDÃO NEGATIVA',
        mensagem: 'Solicitado envio de documentos ou atendimento junto ao setor responsável da Polícia Civil.',
        executedAt: new Date().toISOString()
      });
    }
