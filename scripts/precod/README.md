# Reprodução da apuração pré-COD (Portaria MME 140/2026, art. 3º)

Ferramental de auditoria da planilha `Apuracao_Pre_Pos_COD_MRD_PT-EN_Rev<N>.xlsx`
(`PWC_Docs/DOU_DIARIO_OFICIAL_UNIAO/Curtailment/`). **Não roda em workflow nenhum** — é usado à mão
quando sai uma revisão nova, para regenerar `data/pre_cod_razoes.json`.

## Por que isto existe

A planilha **não guarda um único valor calculado**: toda célula derivada é `<f>` com `<v>` vazio, e
só o Excel produz o número ao abrir. Não dá para *ler* a apuração — tem que *recalcular*. Estes
scripts reimplementam a cadeia das abas 14 a 20 e conferem contra as âncoras da própria planilha.

## Como usar quando sair a Rev07

```bash
cd <scratch>                      # qualquer pasta de trabalho
cp .../Apuracao_..._Rev07.xlsx rev.xlsx
mkdir x && cd x && unzip -q ../rev.xlsx && cd ..
node abas.js                      # confere o mapa aba -> sheetN.xml (a numeração é a POSIÇÃO, 0-based)
node calc.js                      # recalcula tudo; grava resultado.json
node valida.js                    # reproduz a validação mês a mês da aba 15
node serie.js                     # série contínua da aba 20; grava serie.json
node blob.js && node congela.js   # monta o arquivo final
cp data_pre_cod_razoes.json <repo>/data/pre_cod_razoes.json   # e troque _revisao
```

## Conferências que TÊM de fechar

- `1191,17 h` de calendário na aba 17 (a nota da aba 16 declara esse número)
- `1191,17 + 10,41 (sobreposição) = 1201,58 h` do Sinapse `+ 32,70 h` do SAGER `= 1234,28 h`
- validação mês a mês: erro total **0,0000%** e desvio-padrão mensal **~4%**

## ⚠️ O erro de 0% é POR CONSTRUÇÃO

As âncoras de viés (`G5`/`G6` da aba 17) são *definidas* como a razão que faz o total fechar contra
a aba 18. O zero é identidade, não validação. **Nunca publicar o 0%** — o número honesto é o desvio
mensal de ~4%, e a faixa adotada pela planilha é ±15%.

## Armadilhas do XLSX

- `sharedStrings.xml` **não existe**: as strings são inline (`<is><t>`).
- `rId` mapeia 1:1 para `sheetN.xml`, mas o **nome** da aba tem prefixo numérico que é a posição.
- Colunas de referência (`X`, `Y` da aba 17; `J`, `M` da aba 19) também são fórmula — `lib.js` as
  ignora de propósito e os cálculos as reconstroem.
