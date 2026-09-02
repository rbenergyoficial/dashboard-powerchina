# Intake do SCADA — o que falta, e de quem depende

O container `scada-raw` no Azure é alimentado hoje pelo fluxo **“SCADA SharePoint para Blob”** do
Power Automate. Ele é a entrada de **quatro páginas**: SCADA, Solarimetria, Transformadores e
Perdas de PV.

⚠️ **A licença Premium que o sustenta vence em 15/09/2026.** Sem ela o fluxo para, e as quatro
páginas param de receber dado novo **em silêncio** — os geradores continuam rodando e
republicando o que já tinham.

## O que o fluxo faz, lido do gatilho dele em 02/09/2026

| | |
|---|---|
| gatilho | *Quando um arquivo é criado (somente propriedades)* |
| site | `https://powerchinabr.sharepoint.com/sites/POWERCHINA` |
| biblioteca | `Documentos` |
| pasta | `/Documentos Compartilhados/1.OPERAÇÃO E MANUTENÇÃO - O&M - 運作與維護/01 - OPERAÇÃO - 运行记录/11 - Dados_Scada_PWC` |
| conexão | `francisco.barros@powerchina.com.br` |
| destino | Azure Blob, container `scada-raw`, conta `rbenergydata` |

São três passos: detecta o arquivo novo, baixa o conteúdo, grava no blob.

## 🔴 O bloqueio, e por que não se resolve do nosso lado

O SharePoint é **`powerchinabr`** — o tenant da PowerChina. Nossa automação vive no tenant
`rbenergy`. Para ler aquela pasta sem o Power Automate, é preciso um registro de aplicativo **no
tenant da PowerChina**, e a permissão de aplicativo exige **consentimento de administrador de lá**.

Nem eu nem o dono da conta conseguimos conceder isso: é decisão da TI da PowerChina.

## O pedido, pronto para encaminhar

> Precisamos de leitura automatizada (sem usuário interativo) de **uma única pasta** do SharePoint
> corporativo, para um processo que hoje já lê os mesmos arquivos por um fluxo do Power Automate
> em nome de `francisco.barros@powerchina.com.br`. A automação passa a rodar no GitHub Actions.
>
> **1. Registro de aplicativo** no tenant `powerchinabr`, sem usuário — só credencial de
>    aplicativo. Sugestão de nome: `mauriti-scada-intake`.
>
> **2. Permissão de aplicação `Sites.Selected`** (Microsoft Graph), **com consentimento de
>    administrador**.
>
>    🔴 `Sites.Selected` é o mínimo possível: sozinha ela **não dá acesso a site nenhum**. O acesso
>    só existe depois do passo 3, site a site. É estritamente menor que `Sites.Read.All`, que
>    abriria o SharePoint inteiro.
>
> **3. Conceder ao aplicativo o papel `read`** apenas no site
>    `https://powerchinabr.sharepoint.com/sites/POWERCHINA`.
>
> **4. Nos devolver:** `Directory (tenant) ID`, `Application (client) ID` e um **client secret**.

⚠️ Se a política interna não permitir client secret, o registro pode usar **credencial federada
(OIDC)** apontando para `repo:rbenergyoficial/dashboard-powerchina:ref:refs/heads/main` — o mesmo
mecanismo que já usamos no Azure, e que dispensa segredo. Vale oferecer as duas opções.

## O que já está pronto do nosso lado

`scripts/gen-scada-intake.js` — o coletor, com o caminho real acima já escrito.

- **`FONTE=pasta`** lê de uma pasta local. É o modo exercitável, e é o que o ensaio usa: nome,
  deduplicação, idempotência e a guarda de contrato **já estão provados**.
- **`FONTE=graph`** lê do SharePoint. Só falta a credencial.

🔴 **A guarda que mais importa é a de NOME.** Os quatro consumidores exigem padrões diferentes, e
dois deles falham em **silêncio** se o nome mudar:

| consumidor | exige |
|---|---|
| `gen-scada` | prefixo numérico `^(\d+)_` — e **ordena** por ele; sem prefixo o arquivo perde para qualquer outro |
| `gen-irradiancia` | `_IRR_...csv` — o **underscore** antes do `IRR` só existe porque há prefixo |
| `gen-trafo`, `gen-perdas` | carimbo no fim; prefixo tolerado |

O coletor grava com prefixo `AAAAMMDDHHMMSS`, que é numérico e monotônico — sempre maior que o id
de 5 dígitos do legado, e sempre crescente. `casaConsumidor()` **recusa gravar** qualquer nome que
nenhum consumidor leia.

## Enquanto isso

O fluxo continua **ligado**. O vigia `gen-scada-intake-watchdog.js` roda no `scada.yml` e avisa se
o container parar de receber arquivo — então uma parada em 15/09 não passa despercebida.

**Não desligue este fluxo** antes de o ramo Graph rodar e reproduzir o que ele faz.
