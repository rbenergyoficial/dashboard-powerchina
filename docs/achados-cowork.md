# Achados e handoff — sessão Cowork

Canal de repasse entre a sessão Cowork (Claude no desktop) e o Claude Code.
Reginaldo aponta este arquivo para o Claude Code quando houver item de código.

## Divisão de trabalho combinada em 11/08/2026

| Artefato | Dono |
|---|---|
| Dashboards do Grafana (JSON dos painéis, via API) | **Cowork** |
| Repositório, `scripts/`, workflows, pipeline | **Claude Code** |
| Este arquivo (`docs/achados-cowork.md`) | Cowork escreve, Claude Code lê |

Motivo: dashboard não faz merge. Duas sessões salvando o mesmo painel — quem
salva por último apaga a outra em silêncio, sem conflito e sem aviso. No git ao
menos há histórico e conflito visível. Em 11/08 houve cinco commits paralelos no
`gen-executivo.js` e não colidiu por sorte; no dashboard não teria dado.

Se o Claude Code precisar alterar um painel, avisar antes — os scripts do
scratchpad que editam o Grafana (`card_contrato.js`, `secoes.js`, `polir.js`,
`meta_linha.js` e afins) ficam suspensos enquanto valer esta divisão.

Cowork só escreve no repositório neste arquivo. Nada mais.

## Alterações feitas no dashboard `sumario1` em 11/08/2026

Versões 160 → 183. Histórico completo em Configurações → Versões.

- **Mês em curso** deixou de ser medido contra a meta do mês inteiro nos painéis
  17, 10, 13 e 14. A meta do mês aberto passou a ser a soma das metas diárias dos
  dias com energia, e o mês parcial saiu do cálculo da MÉDIA. O painel 14 passou a
  mostrar só meses fechados.
- **Números congelados** removidos de sete descrições. Criadas duas variáveis
  ocultas, `janela_corte` e `fonte_corte`, lidas de `ytd_ufv.corte_janela` e
  `ytd_ufv.corte_fonte`, usadas nos títulos dos piecharts e nos textos.
- **Abaiara** (painel 16) só exibe meses em que as duas séries existem.
- **Card "Posição por contrato"** (painel 3) reescrito: coluna Trajetória usando
  `spark_ating`, `ult_pct` e `delta_pp`, que vinham no JSON sem uso; corte por
  contrato reposto com marcador de estimativa.
- **Paleta por função**: verde `#5FBF8E` acima da meta, vermelho `#E8737A` abaixo,
  âmbar `#E0B84A` conjunto, azul `#7FA8E8` PPA, roxo `#A79BE8` corte,
  cinza-ardósia `#8E9AAD` comparador externo. Barras nativas padronizadas em
  `fillOpacity 50`, `gradientMode opacity`, `lineWidth 1`.
- **Variável `dia`** deixou de ser lista fixa 01–31 e passou a ser query sobre
  `serie_dia_ufv`, filtrada pelo `$mes`. Só lista dias que existem.
- **Card do topo** (painel 113): removido o percentual congelado do pré-COD, que
  dizia 35,1% enquanto `totais_vida.pre_pct` já estava em 34,33%.

## Aberto — lado do código

1. **Reconstrução da série anterior a 17/07/2026.** `RECONSTRUIR=1` segue
   desligado, com motivo documentado no próprio script. Enquanto isso, o corte por
   usina não existe antes de mar/26 e a repartição PPA×ML nesses meses é estimada
   pela média observada dos meses íntegros. O total do conjunto NÃO precisa de
   reconstrução: é medido na subestação de 230 kV e confere com o Way2 entre 98,8%
   e 105,3% de out/25 a jul/26 — nunca herdou o defeito do relé de 34,5 kV.

2. **Varredura de números escritos à mão.** O `35,1%` do pré-COD estava dentro do
   *conteúdo* de um card, não da descrição. Provável que haja outros nos demais
   painéis e nos textos gerados pelo pipeline. Padrão a procurar: percentual ou
   valor absoluto em texto corrido, sem binding.

3. **Cor do sparkline do Mercado Livre.** O campo `spark_ating` traz o HTML pronto
   e pinta a barra do mês corrente com a cor do contrato. O Mercado Livre está em
   `#5FBF8E`, que na convenção nova significa "acima da meta", não uma entidade.
   Trocar por `#45B8C4` no gerador. Hoje o chip do contrato no card é ciano e a
   barra do sparkline ao lado é verde — mesma linha, duas cores para a mesma coisa.
   É o único ponto da página em que a paleta ainda não fecha, e não dá para
   corrigir do lado do dashboard porque a cor vem embutida no dado.

4. **Repositório público com blob sem autenticação.** `executivo.json` e os
   arquivos do ONS são legíveis por qualquer um que descubra a URL — foi assim que
   a sessão Cowork leu os dados, sem credencial. Inclui geração, corte, metas
   contratuais e a estratégia comercial de limitar o ML a 1 MW, esta última em
   texto claro no cabeçalho do `gen-executivo.js`. Decisão de segurança da
   informação, não de engenharia.

## Paleta da página — uma cor, um significado

Consolidada em 11/08/2026. Vale para os painéis e também para qualquer cor que o
pipeline embuta no dado (sparklines, HTML pré-montado nos cards).

A regra que sustenta tudo: **nós somos coloridos, quem serve de comparação é cinza.**
E cor de ENTIDADE nunca se confunde com cor de ESTADO.

| Cor | Significa | Onde aparece |
|---|---|---|
| `#5FBF8E` verde | **estado**: acima da meta | superávit, badge de meses na meta, delta positivo |
| `#E8737A` vermelho | **estado**: abaixo da meta | déficit, delta negativo |
| `#7E8AA0` cinza-azulado | **estado**: entregue até a meta | base das barras empilhadas |
| `#E0B84A` âmbar | **entidade**: Conjunto / nós | card, marcas laterais, "nós" na seção 2 |
| `#A8873A` âmbar apagado | **entidade**: nós, valor estimado | séries estimadas da seção 2 |
| `#7FA8E8` azul | **entidade**: PPA | card, atingimento por contrato |
| `#45B8C4` ciano | **entidade**: Mercado Livre | card, atingimento por contrato |
| `#A79BE8` roxo | **assunto**: corte do ONS | energia cortada, piecharts, coluna do card |
| `#8E9AAD` cinza médio | **referência externa**: Abaiara | comparação de malha |
| `#A8B2C0` cinza claro | **referência externa**: Solar NE | benchmark regional |
| `#5D6B80` cinza escuro | **referência externa**: Eólico NE | benchmark regional |

Saturação: as cores de entidade ficam entre 40% e 71%. Evitar acima de 80% — o
`#F5A623` que estava na seção 2 tinha 91% e atravessava o preenchimento
translúcido, destoando de toda a página.

Preenchimento das barras nativas, padrão em todos os nove gráficos:
`fillOpacity 50`, `gradientMode opacity`, `lineWidth 1`.

Unidade: aparece UMA vez, no rótulo do eixo ou no título — nunca em cada tique.
Percentual é exceção: `%` fica inline, é um caractere.

Separador de milhar: espaço estreito (U+202F), nunca ponto. O ponto significa
apenas decimal, em toda a página.

## Geometria das barras — como o Grafana se comporta de verdade

Apurado por medição em 11/08/2026, depois de três tentativas erradas baseadas em
suposição. Vale a pena ler antes de mexer nesses valores.

**`groupWidth` MENOR fecha o grupo. `barWidth` MAIOR engorda a barra dentro dele.**
O contrário do que o nome sugere. Subir `groupWidth` afasta as barras do mesmo mês
umas das outras, e o par deixa de se formar.

O sintoma de agrupamento quebrado é medível: comparar, num render, a distância
entre os centros das barras DENTRO de um mês contra a distância da última barra de
um mês à primeira do mês seguinte. Se as duas forem parecidas, não há grupo — o
leitor vê uma fileira de barras soltas. Antes da correção, o painel 16 tinha 43 px
de vão interno contra 39 px de vão externo.

Valores que funcionam, com `barWidth` sempre perto de 0,9:

| Séries | `groupWidth` | `barWidth` | Barra resultante |
|---|---|---|---|
| 1 | irrelevante | 0,42 | 31,5% da categoria |
| 2 | 0,45 | 0,90 | 20% da categoria |
| 3 | 0,675 | 0,90 | 20% da categoria |

A regra por trás: `groupWidth` ≈ 0,225 × número de séries. Isso mantém a barra com
a mesma largura em qualquer contagem de séries e preserva o vão entre meses.

Série única usa barra mais larga de propósito — não há grupo a formar, e igualar a
20% deixa o gráfico anêmico ao lado dos agrupados.

`barRadius` uniforme em 0,04.

`showValue`: usar `auto`, não `always`. Com muitas barras num painel de meia
largura, `always` sobrepõe rótulos e corta o último contra a borda.

## Método usado nas verificações

As conferências numéricas foram feitas consultando o `executivo.json` e os
arquivos do ONS através do datasource Infinity do Grafana, com JSONata, via
`POST /api/ds/query`. Reproduz o cálculo sem depender do pipeline e serve para
auditar qualquer número da página de forma independente.
