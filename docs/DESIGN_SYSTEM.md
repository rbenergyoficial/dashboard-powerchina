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
| **atenção** · meta, marco, destaque | — | `#F5A623` |
| **irradiância** (série própria) | — | `#E0B050` |
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
> Se precisar de uma 7ª série: agrupar em "Outros", facetar, ou trocar de visualização.

### Variantes com propósito (tokens legítimos, não duplicatas)
| cor | uso exclusivo |
|---|---|
| `#1E3A2D` | fill do trecho "projeção" (mais escuro que o realizado, na barra da manchete) |
| `#FFD98A` | fim do gradiente do título ("Mauriti") |
| `#8B6B6B` | série **reconstruída/estimada** (pontilhada) — nunca para dado medido |
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
