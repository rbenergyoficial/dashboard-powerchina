# Design System — Dashboards Mauriti (Grafana)

Fonte da verdade para cor, tipografia e convenções dos painéis. Toda cor aqui foi **medida por
pixel-sampling** no render real, não escolhida no olho.

> **Regra de ouro:** nunca usar `rgba()` para casar cor entre painéis — rgba compõe com o fundo, e o
> fundo difere entre painéis, então o mesmo rgba renderiza tons diferentes. **Sempre hex sólido.**

---

## 1. Paleta — pares fill + acento

O padrão nativo do Grafana é sempre o mesmo par: **fill transparente + acento brilhante**. Um
barchart com cor `X` e `fillOpacity: 50` renderiza o fill como a coluna "fill" abaixo.

| papel | fill (área/barra) | acento (borda/linha/texto) |
|---|---|---|
| **positivo** · entregue, meta batida | `#2E5845` | `#43966B` |
| **negativo** · cortado, abaixo da meta | `#703B3F` | `#C85C60` |
| **neutro** · medição, referência | `#48668E` | `#5C86BE` |
| **atenção** · meta, marco, destaque, comissionamento | `#5C462C` | `#F5A623` |
| **restrição** · curtailment, corte imposto pelo ONS | `#453C6E` | `#8B7FD4` |
| **irradiância** (série própria) | — | `#E0B050` medida · `#C79A4A` estimada |
| **outras perdas** / cinza de dado | — | `#525C6B` |

### Paleta categórica — só para gráfico multi-série
Quando o gráfico compara **categorias** (não estados), cada série precisa de cor própria. Usar
**nesta ordem fixa**, nunca ciclando nem inventando um 7º tom:

| ordem | cor | |
|---|---|---|
| 1 | `#43966B` | verde |
| 2 | `#5C86BE` | azul |
| 3 | `#C08A45` | âmbar escuro |
| 4 | `#C85C60` | vermelho |
| 5 | `#4E9A98` | teal |
| 6 | `#5F6672` | cinza (sempre para "outros/aviso") |

> `#C08A45` existe **só aqui**. Fora de gráfico multi-série, âmbar é sempre `#F5A623`.

> **Por que curtailment é ROXO e não vermelho** (decidido em 26/07/2026): vermelho comunica falha, problema NOSSO, algo a corrigir. Curtailment não é falha — é o ONS mandando cortar por excesso de geração no sistema; a usina fez tudo certo. Pintar isso da mesma cor de "abaixo da meta" mistura o que erramos com o que nos foi imposto. Roxo/violeta é a convenção para restrição regulatória.
> **Continua vermelho:** não atingimento de meta, erro alto da projeção, falha de equipamento.
> Se precisar de uma 7ª série: agrupar em "Outros", facetar, ou trocar de visualização.

### Variantes com propósito (tokens legítimos, não duplicatas)
| cor | uso exclusivo |
|---|---|
| `#1E3A2D` | fill do trecho "projeção" (mais escuro que o realizado, na barra da manchete) |
| `#FFD98A` | fim do gradiente do título ("Mauriti") |
| `#8B6B6B` | série **reconstruída/estimada** (pontilhada) — nunca para dado medido |
| `#C79A4A` | **irradiância estimada** por satélite — mesma família da medida `#E0B050`, dessaturada, e sempre tracejada. Justificativa em §11. |
| `#7FC49C` | rótulo textual sobre fill verde |
| `#9AA4B2` | linha de meta tracejada |

## 2. Texto e superfícies

| token | valor | uso |
|---|---|---|
| texto primário | `#F2F4F7` | **o número** (sempre; a cor vai no acento, não no valor) |
| texto secundário | `#8B93A1` | rótulo, unidade, legenda |
| texto terciário | `#5F6672` | nota de rodapé, escala da sparkline |
| fundo do card | `#14161A` | superfície padrão |
| fundo alternativo | `#131519` | chip/pílula dentro do card |
| borda | `#333841` | contorno de card |
| divisor | `#23262C` | separador interno |

**Degraus extra para TABELA densa** (matriz do executivo, 26/07/2026) — 4 níveis não bastavam quando rótulo de coluna, rótulo de linha, número e unidade precisam se distinguir na mesma célula:

| token | uso |
|---|---|
| `#C5CBD4` | rótulo de LINHA em tabela (nome do grupo) — mais forte que o secundário |
| `#A8B0BC` | rótulo de COLUNA (cabeçalho da tabela) |
| `#171A1F` | fundo da linha destacada (o titular da tabela) |

> Regra: rótulo que nomeia número grande **nunca** usa `#5F6672`. Custou três rodadas de ajuste até chegar aqui — texto secundário deve RECUAR, não desaparecer.

## 3. Tipografia

- **Número principal:** 34px, weight 300, `font-variant-numeric: tabular-nums` (alinha dígitos)
- **Rótulo do card:** 9px, `letter-spacing:.15em`, UPPERCASE, mono, `#8B93A1`
- **Unidade:** 13px, `#8B93A1`, ao lado do número na mesma baseline
- **Nota/sub:** 10.5px, `#5F6672`
- **Família:** `Inter, system-ui` no texto; `ui-monospace, Consolas` em números e rótulos técnicos

## 4. Convenções obrigatórias

1. **Toda cor precisa de significado.** Cor por categoria (uma cor por métrica) é decoração →
   proibido. Cor indica **estado** (bateu/não bateu) ou **identidade de série** num gráfico multi-série.
2. **O número é sempre `#F2F4F7`.** O status vai no acento: barra lateral, borda, ou a variação (▲▼).
3. **Todo painel numérico tem `description`** com a **fórmula** e a **fonte**. Número sem fonte
   documentada não é auditável.
4. **Toda unidade explícita** (`unit`) e **decimals fixado** — senão o arredondamento varia com o valor.
5. **Título com contexto:** `Assunto · $ufv — $mes`. Separadores `·` e `—` (não hífen simples).
6. **Formato numérico:** ponto decimal, 2 casas em medidas, inteiro em contagens.
7. **Legenda só com 2+ séries.** Série única → o título já nomeia.
8. **Estimativa nunca no mesmo campo/estilo que medição** — série separada, pontilhada, `#8B6B6B`.

## 5. Componentes — qual usar

| pergunta que o painel responde | componente |
|---|---|
| realizado vs meta | **barchart** horizontal + `thresholdsStyle: line` na meta |
| composição (para onde foi) | **barchart** stacked horizontal |
| série no tempo (dia/mês) | **trend** (eixo numérico) ou **timeseries** (eixo de tempo) |
| um número + histórico | **card HTML** (dynamictext) com sparkline flexbox |
| perfil intradiário | **trend**, eixo `h` 0–24 |

**Nunca** gauge radial para comparar com barras — a gauge usa uma cor só e jamais casa com o par
fill+acento de um barchart. (Custou 11 iterações descobrir.)

## 6. Gotchas do Grafana (custaram tempo real)

- Parser do Infinity é **GJSON**, não JSONata. Multipath: `{"k":path,...}`.
- `dynamictext` **não expõe Handlebars** no editor de helpers → resolver seleção no dado.
- Painel `text` **aceita** gradiente de texto (`background-clip:text`) — não é sanitizado.
- Variável **não interpola** em campo numérico (`max: '$var'` falha) → usar `configFromData`.
- Trend aceita **um frame só** → 2 queries exigem `joinByField` + `renameByRegex` (o join carimba o refId).
- Largura da barra vem do **menor intervalo do eixo** → ponto fracionário encolhe todas as barras.

## 7. Como verificar (obrigatório antes de entregar)

```
1. Renderizar o painel e OLHAR   (get_panel_image)
2. Questão de cor? MEDIR o pixel (render PNG + PIL Counter no interior da forma)
3. Rodar a auditoria             (scripts de auditoria-visual)
4. Conferir: cor tem significado? unidade? descrição com fonte? decimals?
```


## 8. Forma e layout (consistência visual)

- **`barRadius: 0.03`** em TODOS os barcharts. Cantos quase retos; 0.15 arredonda demais e destoa.
- **Largura w24 só se justifica por quantidade de pontos:** histórico de 11 meses, 90 dias, 48 slots.
  Um gráfico de 2 ou 3 categorias em w24 é desperdício — usar w12 e emparelhar com painel do mesmo tema.
- **Eixo categórico usa STRING, nunca timestamp.** Um barchart com campo `timestamp` no eixo X
  desloca as barras dos rótulos e duplica os períodos (`2025-07, 2025-07, 2025-08…`). Usar o rótulo
  pronto (`lbl` = "set/25").
- **Ao converter timeseries → barchart, limpar a herança:** `drawStyle`, `lineWidth`, `lineStyle`,
  `showPoints`, `spanNulls`, `pointSize` nos overrides. Sobra de `drawStyle:line` renderiza a barra
  como contorno vazio.
- **Override de cor fixa vence o threshold.** Para a cor informar status, remover o override `byName`
  com `fixedColor`.

## 9. ⚠️ BUG DE ENCODING — nunca mais

Helper HTTP que faz `s += chunk` **corrompe caracteres multi-byte** (`—`, `ê`, `á`, `ç`) quando eles
caem na fronteira entre dois pacotes TCP. O caractere vira `U+FFFD` e o texto é perdido de forma
irreversível. Aconteceu de verdade: 6 strings destruídas em 3 dashboards, uma delas perdeu 30 caracteres.

**SEMPRE:**
```js
x => { const ch = []; x.on('data', c => ch.push(c));
       x.on('end', () => JSON.parse(Buffer.concat(ch).toString('utf8'))); }
```
E no POST: `Buffer.from(JSON.stringify(body),'utf8')` + `Content-Type: application/json; charset=utf-8`.

**Detecção:** rodar `scripts/varre-encoding.js` após qualquer escrita em lote — ele procura o
replacement character (code point `FFFD`) em títulos, descrições e options de todos os dashboards.

## 10. Painel HTML (`marcusolsson-dynamictext-panel`) — quando o nativo não dá

Use quando o painel nativo **não consegue** o layout pedido (ex.: texto ao lado de um gauge, dentro do
mesmo card). Não use para o que um `stat`/`barchart` já faz bem.

| Regra | Por quê |
|---|---|
| `height: <px>`, nunca `height:100%` | o container do plugin não tem altura → o card encolhe. `px = h*(30+8)-8`, menos ~20 de padding (h10 → 352px) |
| `const hb = context.handlebars` | `handlebars` solto dá "handlebars is not defined". É o que libera aritmética no `helpers` |
| frames em `context.panelData.series` | `context.data` é só o frame *selecionado*, já achatado. Para 2+ queries, leia `panelData` |
| `renderMode: 'data'` com 2+ queries | com `allRows` o plugin desenha um **dropdown de frame** no pé do painel |
| helpers leem tudo, template só chama helper | o template deixa de depender de como o plugin achata os frames |
| formate na query (`$formatNumber(x,"0.00")`) | Handlebars não formata, e `$round(73.70,2)` → `73.7` quebra o alinhamento entre cards irmãos |

**Gauge em CSS** (`conic-gradient`) funciona e não é sanitizado — é o caminho para pôr texto ao lado do
anel no mesmo card. Mande do backend a **string formatada** para o texto e o **número** para o CSS:

```html
<div style="width:196px;height:196px;border-radius:50%;
  background:conic-gradient(#F5A623 0% {{arco}}%, #2A2E37 {{arco}}% 100%)">
  <div style="position:absolute;inset:19px;border-radius:50%;background:#14161A">{{mw}}</div></div>
```

**O parser backend do Infinity nem sempre é JSONata.** No blob Way2 aceita `$sum`/`:=`/filtros; no
endpoint do ONS (`tr.ons.org.br`) a mesma sintaxe devolve `null` — ali é GJSON (caminho direto e
multipath `{"k":path}`, sem aritmética). **Teste no `/api/ds/query` antes de gravar** — e valide a
FAIXA do valor, não só se veio algo.

## 11. Medição × estimativa — como distinguir sem mentir

Regra que já existia (§4.8) mas que a irradiância por satélite obrigou a detalhar: **quando o painel
mostra uma estimativa ao lado de uma medição da mesma grandeza, a diferença tem que ser óbvia sem
ler a legenda.**

Três níveis, do mais forte ao mais fraco. Use SEMPRE o primeiro; a cor é o último recurso.

1. **Campo separado no dado.** Nunca escreva estimativa e medição no mesmo campo. Se o gerador
   preenche `irr` (ONS) e `irr_sat` (satélite), o painel consegue estilizar cada um e a troca é
   automática: quando a medição chega, a estimativa daquele dia deixa de ser emitida.
2. **Traço tracejado + linha fina.** É o que o olho pega primeiro. `custom.lineStyle: {dash:[2,3]}`,
   `lineWidth: 1`, `fillOpacity: 0`. A "Meta do dia" e o "Potencial (estimado)" já usam isso — o
   tracejado no painel significa "não é dado medido".
3. **Cor da mesma família, dessaturada.** Mesma grandeza pede mesma família (`#E0B050` medida →
   `#C79A4A` estimada). Cor de família DIFERENTE seria pior: sugeriria grandeza diferente.

**Declare o erro na `description`.** Estimativa sem erro declarado não é auditável. A da Open-Meteo
diz o número medido: 14% de erro médio, pior dia 71%, e o que ela de fato acerta (a faixa
sol/médio/nuvem em 82% dos dias). Ver a memória `project_irradiancia_satelite`.

**Cuidado com `unit`:** o Grafana agrupa eixo por **string de unidade**. `'suffix: MW'` e
`'suffix:  MW'` (dois espaços) são unidades diferentes e geram DOIS eixos — a série vai para uma
escala própria e qualquer comparação visual morre. Ao criar série nova no mesmo eixo, **herde** a
unidade do painel em vez de redeclarar.

### Régua de escala
Série constante vinda do dado (ex. `cap_mw` = capacidade instalada em cada ponto do perfil) faz duas
coisas com um mecanismo só: desenha a linha de referência **e** força o eixo a chegar nela, igualando
a escala entre todos os períodos. Preferir isso a `max`/threshold no `fieldConfig` quando o valor
depende de variável — **campo numérico de `fieldConfig` não interpola `$var`**.
