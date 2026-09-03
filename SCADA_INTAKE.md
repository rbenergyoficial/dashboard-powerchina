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
e avisa se o container parar de receber arquivo. **Os dois são vigiados**, cada um com o limiar
medido no próprio container:

| container | alerta | crítico | de onde saiu |
|---|---|---|---|
| `scada-raw` | 50 h | 74 h | 38 lotes · mediana 23,6 h · p90 49,9 h |
| `inversores-raw` | 170 h | 336 h | 13 lotes · mediana 76,7 h · máximo 320,3 h |

⚠️ **O p90 não serve de alerta no `inversores-raw`, ao contrário do SCADA.** Metade dos vãos cai
na faixa de 74 a 170 h, então um corte no p90 (133 h) ficaria **dentro da banda normal** e
acenderia no caso comum. O corte tem de ficar acima dela.

⚠️ **E a estimativa que eu tinha escrito estava errada**: não é "algumas vezes por mês" — são
~2 depósitos por semana. Nos 8 lotes de 09/08 a 02/09 os vãos vão de 29,6 a 137,7 h.

🔴 **O que o vigia dos inversores NÃO faz**, dito antes que alguém conte com ele: com 7 dias de
alerta, ele não pega uma queda em 15/09 a tempo. A cadência daquele container é humana e
irregular, e não dá para apertar o corte sem alarme falso — quem avisa depressa é o fluxo
falhando, não a idade do arquivo. Ali ele serve para parada **prolongada**, e só.

⚠️ Container **sem limiar medido** é recusado no modo `vigiar`, em vez de herdar o número de
outro. A recusa vale só para `vigiar`: `MODO=medir` roda em qualquer container — é ele que produz
a distribuição de onde o limiar sai, e bloqueá-lo tornaria o caminho impossível de percorrer. Por
despacho, a entrada `vigia_container` do `scada.yml` aponta a medição para outro container.

**Não desligue estes fluxos** antes de o ramo Graph rodar e reproduzir o que eles fazem.
