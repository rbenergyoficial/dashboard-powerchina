const b=require('./pre_cod_razoes.json');
const out={
 _fonte:"Planilha Apuracao_Pre_Pos_COD_MRD_PT-EN_Rev06.xlsx (PWC_Docs/DOU_DIARIO_OFICIAL_UNIAO/Curtailment), abas 14 a 20. Emissao 11/08/2026. Portaria MME 140/2026, art. 3o.",
 _unidade:"MWh",
 _nota:"CONGELADO da Rev06 em 15/08/2026. A planilha NAO guarda valor calculado — toda celula derivada e formula sem cache, so o Excel produz o numero ao abrir. Por isso a cadeia foi reimplementada e conferida contra as ancoras da propria planilha: as 1191,17 h de calendario da aba 17 e a validacao mes a mes da aba 15 batem exatamente. Ao chegar a Rev07, refazer com scratchpad/precod/*.js e trocar _revisao.",
 _revisao:"Rev06",
 _emissao:"2026-08-11",
 _congelado_em:"2026-08-15",
 _aviso_validacao:"O erro TOTAL de 0% da validacao e POR CONSTRUCAO: as ancoras de vies sao definidas como a razao que faz o total fechar contra a aba 18. Nao e validacao, e identidade. O numero honesto e o desvio-padrao MENSAL de 4,00%, e ainda assim medido em tres meses so, todos de estacao seca. A faixa adotada e +-15%, quase 4x a dispersao medida — e julgamento conservador, nao a dispersao observada. NUNCA publicar o 0%.",
 janela:{...b.janela, _nota:"Janela do art. 3o. O pre-COD e ESTIMATIVA (+-15%); o trecho SAGER e calculado sobre dado medido."},
 razoes:b.razoes,
 compensavel:{_regra:"Portaria 140/2026: CNF e REL sao compensaveis; ENE nao e; ND fica a classificar.",
   mwh:b.janela.compensavel_mwh, pct:b.janela.compensavel_pct},
 pre_cod:b.pre_cod,
 validacao:b.validacao,
 serie_continua:{_nota:"Aba 20, set/25 a jul/26. FORA da janela do art. 3o — serve de acompanhamento e de validacao independente. ATENCAO: 'perda_nos_intervalos_pct' tem como denominador SO os intervalos com restricao, nao o mes inteiro; nao confundir com a taxa mensal de corte do executivo.json (mar/26 sai 28,3% aqui contra 22,87% la). O campo ref_ons_valida marca de mar/26 em diante: antes disso o ONS publica referencia ABAIXO da geracao verificada e a comparacao nao vale.",
   meses:b.serie_continua}
};
require('fs').writeFileSync('data_pre_cod_razoes.json',JSON.stringify(out,null,1));
console.log('bytes:',require('fs').statSync('data_pre_cod_razoes.json').size);
