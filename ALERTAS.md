# Para onde vai um alerta

Os vigias do projeto (`gen-way2-watchdog`, `gen-relogio-watchdog`, `gen-scada-intake-watchdog`)
mandam tudo por `scripts/lib-alerta.js`, que entrega em **três destinos independentes**.

| destino | como | depende de |
|---|---|---|
| **webhook** | POST num fluxo do Power Automate | 🔴 licença Premium, **vence 15/09/2026** |
| **issue** | issue no próprio repositório | `GITHUB_TOKEN` do Actions + `issues: write` |
| **email** | Microsoft Graph `sendMail` | OIDC + `id-token: write` — **sem segredo** |

> 🔴 Este repositório é **público**. Endereço de pessoa, identificador de locatário, de aplicativo
> e de assinatura **não entram aqui** — eles vivem nas *variables* do repositório e no documento
> interno. É a mesma regra do portão `G14` para a `description` de painel: o know-how fica no
> lugar interno, não no texto público.

## 🔴 A issue é REGISTRO, não NOTIFICAÇÃO

Medido em 02/09/2026: o repositório tem **1 colaborador e ZERO watchers**, e quem recebe os
alertas hoje **não tem conta no GitHub**.

Ou seja: a issue guarda o evento com histórico e dedup, e **não avisa a pessoa que precisa saber**.
Foi por isso que o canal de e-mail teve de existir antes de o fluxo poder ser desligado — a
"segunda rede" que eu havia declarado não cobria o destinatário real.

## O canal de e-mail, e por que ele não tem segredo

O GitHub troca um token de identidade próprio por um token do Graph. A confiança vive no Entra,
amarrada a **um assunto exato**:

```
repo:<owner>/<repo>:ref:refs/heads/main
```

Nenhum outro repositório, branch, tag ou pull request consegue usá-la. Como não existe senha, não
há o que vazar, girar ou expirar.

A configuração vem de quatro **variables** do repositório — identificadores, não credenciais:

| variável | o que é |
|---|---|
| `AZ_MAIL_TENANT_ID` | locatário do Entra |
| `AZ_MAIL_CLIENT_ID` | aplicativo com `Mail.Send` (aplicação), consentido |
| `MAIL_DE` | caixa remetente |
| `MAIL_PARA` | destinatário (aceita vários, separados por `,` ou `;`) |

## ⚠️ DÍVIDA: restringir o `Mail.Send` a uma caixa só

`Mail.Send` de aplicação alcança **qualquer caixa do locatário** até ser restringida. Hoje o que
limita o alcance é a credencial federada: só o branch `main` deste repositório consegue pedir o
token. É forte, mas não é o mínimo.

O mínimo exige Exchange Online PowerShell — **não instalado na máquina de trabalho**:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName <caixa-remetente>

New-DistributionGroup -Name "Caixas-Alertas-Mauriti" -Type Security -Members <caixa-remetente>

New-ApplicationAccessPolicy -AppId <AZ_MAIL_CLIENT_ID> `
  -PolicyScopeGroupId "Caixas-Alertas-Mauriti" -AccessRight RestrictAccess `
  -Description "o app de alertas envia so como a caixa remetente"

Test-ApplicationAccessPolicy -Identity <caixa-remetente> -AppId <AZ_MAIL_CLIENT_ID>
```

Depois disso, qualquer outra caixa responde `AccessDenied`.

## 🔴 Normalização sem evento aberto NÃO aciona canal nenhum

O vigia da intake do SCADA chama `resolve` a **cada rodada em que está tudo bem**. O canal de
issue já tratava isso (*"nada aberto para fechar"*), mas o **webhook não sabe o que é `resolve`**:
ele só posta, e o fluxo manda e-mail. Saía um *"normalizada"* por rodada.

Ligar o e-mail sem corrigir isso multiplicaria o ruído — e **alerta que chega todo dia sem motivo
ensina a ignorar o alerta**, que é o oposto do que este módulo existe para fazer.

Com evento aberto, a confirmação continua saindo por todos os canais: ela é o fechamento, e quem
recebeu o aviso precisa saber que acabou.

## `ensaio-alerta.yml` — o caminho de REDE

Os outros ensaios do canal rodam contra um GitHub simulado, de propósito: um que abrisse issue de
verdade a cada execução encheria o repositório do ruído que o dedup existe para evitar. Isso prova
a **lógica** e deixa a **rede** sem prova — e canal de alerta que nunca foi exercitado não está
testado.

Este manda um alerta de verdade, **só por `workflow_dispatch`**, com `[ENSAIO — ignore]` no
assunto. O critério é **por canal**: passar porque a issue subiu esconderia justamente o canal que
se queria provar.

⚠️ A listagem de issues do GitHub é **eventualmente consistente** — um `resolve` disparado logo
depois da criação responde "nada aberto para fechar" e deixa a issue aberta. Em produção isso não
aparece (alerta e normalização ficam separados no tempo); só o ensaio os cola, e por isso ele
espera e repete.

## Aposentar o fluxo de alertas

**Só depois** de um alerta de verdade ter saído por e-mail pelo canal novo. Alerta é justamente o
que não se migra no escuro: se o canal novo falhar em silêncio, some o alerta **e** some a notícia
de que ele sumiu.

⚠️ O fluxo também é o dono do `PA_ALERT_WEBHOOK`. Desligá-lo faz o canal `webhook` responder
`FALHOU` — o que é **correto e visível** no log de cada vigia, e não derruba os outros dois.
