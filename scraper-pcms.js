// Preenchimento explícito mapeando Filiação 1 (Mãe) e Filiação 2 (Pai)
    await frameAtestado.evaluate((payload) => {
      const setFieldValue = (selector, val) => {
        const el = document.querySelector(selector);
        if (el && val) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      };

      // Identidade civil MS
      const selectIdentidadeMs = document.querySelector('#cmbIdentidadeMS');
      if (selectIdentidadeMs) {
        selectIdentidadeMs.value = payload.ufRg === 'MS' ? 'S' : 'N';
        selectIdentidadeMs.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setFieldValue('#txtNome', payload.nome);
      
      // FILIAÇÃO 1 é obrigatoriamente a Mãe
      setFieldValue('#txtMae', payload.filiacao1 || payload.mae);
      
      // FILIAÇÃO 2 é o Pai
      setFieldValue('#txtPai', payload.filiacao2 || payload.pai);
      
      setFieldValue('#txtDataNascimento', payload.dataNascimento);

      const selectDoc = document.querySelector('#cmbTipoDocumento');
      if (selectDoc) {
        selectDoc.value = payload.cpf ? 'CPF' : 'RG';
        selectDoc.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setFieldValue('#txtNumeroDocumento', payload.cpf || payload.rg);
    }, {
      nome: rawName.toUpperCase().trim(),
      filiacao1: (dados.filiacao1 || rawMother).toUpperCase().trim(),
      filiacao2: (dados.filiacao2 || rawFather).toUpperCase().trim(),
      dataNascimento: dataFormatada,
      cpf: cpfLimpo,
      rg: rgLimpo,
      ufRg: rawUfRg.toUpperCase().trim()
    });
