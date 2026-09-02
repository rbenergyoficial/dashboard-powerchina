# O relógio

Dispara os workflows deste repo na cadência que **eles próprios declaram**. Não coleta e não gera
nada — toda a lógica continua nos geradores, com as guardas e o gauntlet que eles já têm.

## 🔴 Por que ele existe

O agendador do GitHub entrega uma fração do que o cron pede. Medido em 01/09/2026, 40 execuções
de cada workflow:

| workflow | eventos | mediana | pior caso |
|---|---|---|---|
| `way2-recent` | 39 de 40 por dispatch externo | **5 min** | 5 min |
| `executivo` | 24 de 40 pelo agendador | **159 min** | **970 min (16 h)** |

Os dois declaram cron. **A diferença é só quem aperta o botão.** Quem apertava era um fluxo do
Power Automate, por HTTP — conector premium, licença com prazo. O relógio ocupa esse lugar sem
depender de licença nenhuma.

## O que ele NÃO é

⚠️ Não é um lugar para pôr lógica. A tentação de "já que estou aqui, coleto também" é justamente
o que tornaria a próxima migração cara. Os geradores ficam onde estão.

⚠️ **Função gerenciada do Static Web Apps não serviria** — ela aceita só gatilho HTTP. Medido antes
de escolher, não suposto.

## A agenda é GERADA, nunca escrita

`agenda.json` sai dos crons dos próprios workflows, por `gerar-agenda.js`.

```
node relogio/gerar-agenda.js             regrava
node relogio/gerar-agenda.js --conferir  não grava; sai 1 se divergir  ← o passo do CI
```

🔴 Se alguém mudar um cron num workflow e esquecer a tabela, o relógio continua tocando no horário
**antigo** — e nada quebra, nada fica vazio, o job só passa a rodar na hora errada. Silencioso e
plausível, que é o modo de falhar mais caro desta casa. O `relogio-confere.yml` roda a conferência
a cada push que toca em workflow ou na agenda.

⚠️ **O cron do GitHub tem 5 campos; o NCRONTAB do Azure tem 6** — o primeiro é o *segundo*. Os dois
correm em UTC, então a conversão é só prefixar `0 ` e não há fuso a acertar. Errar isso desloca
tudo em uma unidade e o horário sai **plausível**, que é pior que sair quebrado. Há guarda
conferindo que todo horário tem 6 campos.

⚠️ NCRONTAB aceita lista de **horas** (`13,23`), não lista de expressões. Crons que só diferem na
hora viram um temporizador; os demais viram vários. Por isso 15 workflows dão **16 temporizadores**
(o `scada` tem dois minutos diferentes).

🔴 Workflow com cron **sem `workflow_dispatch`** faz a geração abortar: a API recusa o disparo com
422, e descobrir isso no horário é uma rodada perdida sem explicação.

## Guardas em execução

- **Não empilha**: antes de disparar, pergunta se já há execução `in_progress` ou `queued`. Foi
  empilhamento que fez o fluxo do Power Automate ser *throttled* em 09/07/2026, com runs zumbis
  marcadas como canceladas segurando o slot por mais de 10 h.
- **Falha alto**: erro no disparo estoura, e a execução fica vermelha no Azure. Engolir deixaria o
  relógio parado sem ninguém saber.
- **Não dispara ao subir** (`runOnStartup: false`): publicar o app não é motivo para tocar os 16 de
  uma vez.
- **Sonda**: `GET /api/saude` devolve a agenda que subiu e se o token está presente — dá para
  conferir sem esperar o próximo horário.

## O que falta para ele funcionar

| passo | onde |
|---|---|
| criar o Function App (Consumption, Node 20, Linux) | portal do Azure |
| `GH_TOKEN` = PAT com `actions: write` neste repo | **Configurações do aplicativo** do Function App |
| `RELOGIO_APP_NAME` = nome do recurso | *Variables* do repo no GitHub |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | *Secrets* do repo no GitHub |

⚠️ O `GH_TOKEN` vive **no Azure**, nunca no repo. O repo é público.

ℹ️ Custo: 16 temporizadores, dominados pelo de 5 min — ~300 execuções/dia contra **1 milhão/mês
grátis** no plano Consumption.

## Dívida declarada

⚠️ O workflow do Static Web Apps usa `app_location: "/"`, então **o repo inteiro é a fonte do
site** — esta pasta acaba servida como arquivo estático. Não há segredo aqui (o token vive no
Azure) e o repo já é público, então é feio, não perigoso. A saída limpa é o relógio em repo
próprio, no dia em que houver um.

## Depois que o relógio estiver no ar

1. Desligar o fluxo **"Way2 Eletrico 5min"** no Power Automate.
2. Tirar o `continue-on-error` do passo de coleta no `way2-recent.yml` — enquanto o fluxo é a rede
   de segurança ele faz sentido; sem o fluxo, ele deixaria a coleta falhar em silêncio.
3. Só então avaliar cancelar a licença.

## 🔴 Uma run PRESA desligou um workflow por 26 dias (02/09/2026)

O `way2-agg.yml` tinha uma run criada em **07/08** parada em `queued`: zero jobs, `updated_at`
igual ao `created_at`, e o próprio GitHub recusando cancelar (HTTP 409). Registro morto.

A `jaRodando` lia `total_count > 0`, concluía "já está rodando" e **pulava o disparo. Toda hora.**

O efeito é o modo de falhar mais caro: nada quebra, nada fica vermelho, e o workflow cai do
relógio para o agendador do GitHub — que entregou **mediana de 146 min** contra os 60 declarados,
p90 de 451 e máximo de **796 min**. A correlação fecha: dos 16 workflows da agenda, o único que o
relógio nunca disparava era o único com run presa.

⚠️ **O teto não é escolhido, sai da plataforma**: um job do GitHub morre em 6 h, então run mais
velha que isso não pode estar viva. O maior `timeout-minutes` do repo é 120 — 3× de folga.

✅ Provado no ar: primeiro `workflow_dispatch` do `way2-agg` em **02/09 20:05:01Z**, no segundo
exato do gatilho. `ensaio-guarda.js` cobre as duas direções e as bordas do teto.

## 🔴 O CI NUNCA publicou o relógio — e dizia `success`

`RELOGIO_APP_NAME` nunca foi definida, então o passo "O destino existe?" saía com `ok=false` e
os quatro passos seguintes eram **pulados**. Job verde a cada push. O que estava no ar era o
pacote de 01/09, publicado à mão; duas correções posteriores nunca chegaram nele.

⚠️ E o motivo de o segredo nunca ter sido criado: **o app está em Flex Consumption, que não emite
perfil de publicação**. O workflow foi escrito para um plano que o app não usa. Hoje ele **falha**
com a lista do que falta.

## Como publicar à mão (enquanto o CI não publica)

```
node gerar-agenda.js --conferir
npm install --omit=dev
```

🔴 **O zip TEM de carregar permissão Unix.** `Compress-Archive` do Windows não grava esse campo; o
Flex monta o pacote como sistema de arquivos Linux, o host não consegue **ler** os arquivos, e o
resultado é **zero funções e zero erros** — `/admin/host/status` responde `Running` com
`errors: 0`, e `/admin/functions` devolve lista vazia. Foi assim que o relógio ficou fora do ar
por ~20 min em 02/09.

O zip se monta com `zipfile` do Python, `zi.create_system = 3` e `zi.external_attr = 0o644 << 16`.
E o envio é o OneDeploy (`config-zip` e `az functionapp deploy` não servem no Flex — o segundo
responde 415):

```
POST https://<app>.scm.azurewebsites.net/api/publish?RemoteBuild=false
     Authorization: Bearer <az account get-access-token --resource https://management.core.windows.net/>
     Content-Type: application/zip
```

**A conferência é `/admin/functions`, não o status do deploy**: o pipeline do Kudu reporta
`status 4` (sucesso) mesmo quando o host não consegue montar o pacote.
