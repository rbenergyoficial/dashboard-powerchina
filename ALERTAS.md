# Para onde vai um alerta

Os vigias do projeto (`gen-way2-watchdog`, `gen-relogio-watchdog`, `gen-scada-intake-watchdog`)
mandam tudo por `scripts/lib-alerta.js`, que entrega em **três destinos independentes**.

| destino | como | depende de |
|---|---|---|
| **webhook** | POST no fluxo *Central de Alertas · Mauriti* | 🔴 licença Power Automate, **vence 15/09/2026** |
| **issue** | issue no próprio repositório | `GITHUB_TOKEN` do Actions + `issues: write` |
| **email** | Microsoft Graph `sendMail` | OIDC + `id-token: write` — **sem segredo** |

## 🔴 A issue é REGISTRO, não NOTIFICAÇÃO

Medido em 02/09/2026: o repositório tem **1 colaborador e ZERO watchers**, e o destinatário dos
alertas — `francisco.barros@powerchina.com.br`, lido do fluxo — **não tem conta no GitHub**.

Ou seja: a issue guarda o evento com histórico e dedup, e **não avisa a pessoa que precisa saber**.
Foi por isso que o canal de e-mail teve de existir antes de o fluxo poder ser desligado.

## O canal de e-mail, e por que ele não tem segredo

O GitHub troca um token de identidade próprio por um token do Graph. A confiança vive no Entra,
amarrada a **um assunto exato**:

```
repo:rbenergyoficial/dashboard-powerchina:ref:refs/heads/main
```

Nenhum outro repositório, branch, tag ou pull request consegue usá-la. Como não existe senha, não
há o que vazar, girar ou expirar — o que importa num repositório **público**.

| peça | valor |
|---|---|
| app | `mauriti-alertas` · `d1202d1c-14c0-4c55-8292-04375e602a52` |
| tenant | `b91f0016-d905-498b-bd75-a9bf6a62f269` |
| permissão | `Mail.Send` (aplicação), com consentimento de administrador |
| remetente | `rb@rbenergy.com.br` |
| destinatário | `francisco.barros@powerchina.com.br` |

As quatro variáveis (`AZ_MAIL_TENANT_ID`, `AZ_MAIL_CLIENT_ID`, `MAIL_DE`, `MAIL_PARA`) são
identificadores, não credenciais — por isso vão em `vars`, não em `secrets`.

## ⚠️ DÍVIDA: restringir o `Mail.Send` a uma caixa só

`Mail.Send` de aplicação alcança **qualquer caixa do tenant** até ser restringida. Hoje o que
limita o alcance é a credencial federada: só o branch `main` deste repositório consegue pedir o
token. Isso é forte, mas não é o mínimo.

O mínimo exige Exchange Online PowerShell — **não instalado nesta máquina**:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName rb@rbenergy.com.br

New-DistributionGroup -Name "Caixas-Alertas-Mauriti" -Type Security `
  -Members rb@rbenergy.com.br

New-ApplicationAccessPolicy `
  -AppId d1202d1c-14c0-4c55-8292-04375e602a52 `
  -PolicyScopeGroupId "Caixas-Alertas-Mauriti" `
  -AccessRight RestrictAccess `
  -Description "mauriti-alertas envia so como rb@"

Test-ApplicationAccessPolicy -Identity rb@rbenergy.com.br `
  -AppId d1202d1c-14c0-4c55-8292-04375e602a52
```

Depois disso o app só consegue enviar como `rb@rbenergy.com.br`, e qualquer outra caixa responde
`AccessDenied`.

## 🔴 Normalização sem evento aberto NÃO aciona canal nenhum

O vigia da intake do SCADA chama `resolve` a **cada rodada em que está tudo bem**. O canal de
issue já tratava isso (*"nada aberto para fechar"*), mas o **webhook não sabe o que é `resolve`**:
ele só posta, e o fluxo manda e-mail. Hoje sai um *"normalizada"* por rodada.

Ligar o e-mail sem corrigir isso multiplicaria o ruído — e **alerta que chega todo dia sem motivo
ensina a ignorar o alerta**, que é o oposto do que este módulo existe para fazer.

Com evento aberto, a confirmação continua saindo por todos os canais: ela é o fechamento, e quem
recebeu o aviso precisa saber que acabou.

## Aposentar o fluxo *Central de Alertas · Mauriti*

**Só depois** de um alerta de verdade ter saído por e-mail pelo canal novo. Alerta é justamente o
que não se migra no escuro: se o canal novo falhar em silêncio, some o alerta **e** some a notícia
de que ele sumiu.

⚠️ O fluxo também é o dono do `PA_ALERT_WEBHOOK`. Desligá-lo faz o canal `webhook` responder
`FALHOU` — o que é **correto e visível** no log de cada vigia, e não derruba os outros dois.
