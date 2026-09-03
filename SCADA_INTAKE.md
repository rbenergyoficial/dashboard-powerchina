# Intake de arquivo bruto — o que falta, e de quem depende

Dois containers no Azure são alimentados hoje por fluxos do **Power Automate**:

| container | páginas que dependem dele |
|---|---|
| `scada-raw` | SCADA · Solarimetria · Transformadores · Perdas de PV |
| `inversores-raw` | Inversores |

⚠️ **A licença Premium que os sustenta vence em 15/09/2026.** Sem ela os fluxos param, e as cinco
páginas param de receber dado novo **em silêncio** — os geradores continuam rodando e republicando
o que já tinham.

## 🔴 O bloqueio, e ele é UM só para os dois

As pastas de origem vivem no locatário Microsoft 365 **do cliente**, não no nosso — e são a mesma
biblioteca, do mesmo site. Lê-las sem o Power Automate exige um registro de aplicativo com
permissão `Sites.Selected` e **consentimento de administrador do locatário de lá**; não se resolve
do nosso lado.

Isso é boa notícia de escopo: **um único pedido de acesso destrava as duas intakes**, e o mesmo
coletor serve as duas — o que muda é `RAW_CONTAINER` e a pasta de origem.

> 📄 **O pedido formal — site, caminho, identificadores e o passo a passo do consentimento — é
> INTERNO** e vive fora deste repositório, em
> `PWC_Docs\Integracao_SCADA_SharePoint\Pedido_acesso_admin_PowerChina.md`.
>
> 🔴 Este repositório é **público**. Nada aqui deve nomear site, caminho de pasta, conta de
> armazenamento, endereço de pessoa ou locatário. É a mesma regra do portão `G14` para a
> `description` de painel: o know-how vive no documento interno, não no texto público.

## O que já está pronto do nosso lado

`scripts/gen-scada-intake.js` — o coletor, um só para os dois containers.

- **`FONTE=pasta`** lê de uma pasta local. É o modo exercitável, e é o que
  `scripts/ensaio-scada-intake.js` usa: nome, deduplicação, idempotência, ordem de gravação e as
  guardas de contrato **já estão provados**, nos dois containers.
- **`FONTE=graph`** lê do SharePoint por credencial de aplicativo. Escrito; **falta a credencial
  para ser exercitado**. Site e caminho vêm de variáveis de ambiente, não do código.

O ramo Graph trata as duas coisas que erram calado:

- cada segmento do caminho vai por `encodeURIComponent` — o caminho tem acento **e** ideograma, e
  a URL crua devolve 400 com uma mensagem que parece dizer que a pasta não existe;
- paginação pelo `@odata.nextLink` — a pasta acumula um arquivo por dia por parque, e parar na
  primeira página seria uma coleta pela metade **com cara de sucesso**.

## 🔴 As guardas que mais importam

### 1 · O NOME, e ele é por CONTAINER

Os cinco consumidores exigem padrões diferentes, e dois deles falham em **silêncio** se o nome
mudar:

| consumidor | exige |
|---|---|
| `gen-scada` | prefixo numérico `^(\d+)_` — e **ordena** por ele; sem prefixo o arquivo perde para qualquer outro |
| `gen-irradiancia` | `_IRR_...csv` — o **underscore** antes do `IRR` só existe porque há prefixo |
| `gen-trafo`, `gen-perdas` | carimbo no fim; prefixo tolerado |
| `gen-inversores` | `.xlsx` **ou `.xlsm`**; identifica a planilha pelo conteúdo, não pelo nome |

O coletor grava com prefixo `AAAAMMDDHHMMSS`, numérico e monotônico — sempre maior que o id de 5
dígitos do legado, e sempre crescente. `casaConsumidor()` **recusa gravar** qualquer nome que
nenhum consumidor leia.

⚠️ **`.xlsx` existe nos dois containers**, então o contrato é por container e não só por nome. Sem
isso uma planilha de inversores casaria a regra do `gen-scada` — passaria na guarda, porque o
prefixo satisfaz as duas, e ficaria atribuída ao consumidor errado.

⚠️ **As extensões aceitas saem do próprio contrato**, nunca de uma lista escrita ao lado. Foi uma
lista à mão (`csv|xlsx`) que teria engolido a planilha de falhas dos inversores, que virou `.xlsm`
em 20/08/2026 — sem erro, sem log, só o painel parando de receber versão nova.

### 2 · A ORDEM de gravação, por causa dos inversores

O `gen-inversores` escolhe a planilha vigente pelo **`lastModified` do blob**, que é o instante do
upload — não o do arquivo na origem. Subindo na ordem em que a API listou, a versão mais antiga
pode virar a mais recente do container, e o painel passa a mostrar dado velho sem nada ficar
vermelho. O coletor grava em ordem cronológica da fonte, e o ensaio reprova a versão sem isso.

### 3 · O RASCUNHO continua reconhecível

O `gen-inversores` descarta planilha marcada `em revisão`, `cópia`, `rascunho` — por **substring do
nome**. O carimbo é um *prepend*, então a marca sobrevive; um coletor que **renomeasse** faria um
rascunho passar por versão boa, e o painel mostraria dado provisório sem nada ficar vermelho.

## Enquanto isso

Os fluxos continuam **ligados**. O vigia `scripts/gen-scada-intake-watchdog.js` roda no `scada.yml`
e avisa se o `scada-raw` parar de receber arquivo — então uma parada em 15/09 não passa
despercebida.

O limiar dele (**50 h para alerta, 74 h para crítico**) saiu de medição, não de escolha: 38
depósitos colapsados em lote deram mediana 23,6 h e p90 49,9 h. `MODO=medir` reimprime a
distribuição a qualquer momento.

⚠️ **O `inversores-raw` ainda não tem vigia, e isso é deliberado.** O limiar é por container, e o
dele não foi medido — lá a equipe salva a planilha algumas vezes por **mês**, então herdar as 50 h
do SCADA acenderia um alarme por dia, e alarme que acende sempre ensina a ignorar a ferramenta. O
vigia **recusa carregar** para um container sem limiar medido, em vez de inventar o número.

**Não desligue estes fluxos** antes de o ramo Graph rodar e reproduzir o que eles fazem.
