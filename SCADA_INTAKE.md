# Intake do SCADA — o que falta, e de quem depende

O container `scada-raw` no Azure é alimentado hoje por um fluxo do **Power Automate**. Ele é a
entrada de **quatro páginas**: SCADA, Solarimetria, Transformadores e Perdas de PV.

⚠️ **A licença Premium que o sustenta vence em 15/09/2026.** Sem ela o fluxo para, e as quatro
páginas param de receber dado novo **em silêncio** — os geradores continuam rodando e
republicando o que já tinham.

## 🔴 O bloqueio

A pasta de origem vive no locatário Microsoft 365 **do cliente**, não no nosso. Ler aquela pasta
sem o Power Automate exige um registro de aplicativo com permissão `Sites.Selected` e
**consentimento de administrador do locatário de lá** — não se resolve do nosso lado.

> 📄 **O pedido formal — site, caminho, identificadores e o passo a passo do consentimento — é
> INTERNO** e vive fora deste repositório, em
> `PWC_Docs\Integracao_SCADA_SharePoint\Pedido_acesso_admin_PowerChina.md`.
>
> 🔴 Este repositório é **público**. Nada aqui deve nomear site, caminho de pasta, conta de
> armazenamento, endereço de pessoa ou locatário. É a mesma regra do portão `G14` para a
> `description` de painel: o know-how vive no documento interno, não no texto público.

## O que já está pronto do nosso lado

`scripts/gen-scada-intake.js` — o coletor.

- **`FONTE=pasta`** lê de uma pasta local. É o modo exercitável, e é o que
  `scripts/ensaio-scada-intake.js` usa: nome, deduplicação, idempotência e a guarda de contrato
  **já estão provados**.
- **`FONTE=graph`** lê do SharePoint por credencial de aplicativo. Escrito; **falta a credencial
  para ser exercitado**. Site e caminho vêm de variáveis de ambiente, não do código.

O ramo Graph trata as duas coisas que erram calado:

- cada segmento do caminho vai por `encodeURIComponent` — o caminho tem acento **e** ideograma, e
  a URL crua devolve 400 com uma mensagem que parece dizer que a pasta não existe;
- paginação pelo `@odata.nextLink` — a pasta acumula um arquivo por dia por parque, e parar na
  primeira página seria uma coleta pela metade **com cara de sucesso**.

## 🔴 A guarda que mais importa é a de NOME

Os quatro consumidores exigem padrões diferentes, e dois deles falham em **silêncio** se o nome
mudar:

| consumidor | exige |
|---|---|
| `gen-scada` | prefixo numérico `^(\d+)_` — e **ordena** por ele; sem prefixo o arquivo perde para qualquer outro |
| `gen-irradiancia` | `_IRR_...csv` — o **underscore** antes do `IRR` só existe porque há prefixo |
| `gen-trafo`, `gen-perdas` | carimbo no fim; prefixo tolerado |

O coletor grava com prefixo `AAAAMMDDHHMMSS`, numérico e monotônico — sempre maior que o id de 5
dígitos do legado, e sempre crescente. `casaConsumidor()` **recusa gravar** qualquer nome que
nenhum consumidor leia.

## Enquanto isso

O fluxo continua **ligado**. O vigia `scripts/gen-scada-intake-watchdog.js` roda no `scada.yml` e
avisa se o container parar de receber arquivo — então uma parada em 15/09 não passa despercebida.

O limiar dele (**50 h para alerta, 74 h para crítico**) saiu de medição, não de escolha: 38
depósitos colapsados em lote deram mediana 23,6 h e p90 49,9 h. `MODO=medir` reimprime a
distribuição a qualquer momento.

**Não desligue este fluxo** antes de o ramo Graph rodar e reproduzir o que ele faz.
