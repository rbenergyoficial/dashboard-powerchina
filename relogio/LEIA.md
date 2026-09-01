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
