// gen-scada-db-vigia.js — o BANCO do supervisorio parou de chegar? (lote scada-db, 22/10/2026)
//
// 🔴 POR QUE ELE EXISTE
// Desde 22/10/2026 o supervisorio do portal vem do historico do banco (`lib-scada-db.js`): a VM da usina extrai um zip por dia
// (`MRT_AAAA-MM-DD.zip`) e a ponte o leva ao cofre (`backup-dados-scada`, prefixo `SCADA_DB/saida/`). Quando a extracao ou a
// ponte para, o `gen-scada.js` NAO falha: republica o que ja tinha, e a tela segue com o ultimo dia como se fosse o de ontem.
// Este vigia troca esse silencio por um alerta. Substitui o vigia da intake do `scada-raw` (o export de 30 min, que acabou em
// 15/10/2026 e deixou de ser fonte por decisao do humano).
//
// O QUE ELE MEDE
//   O ULTIMO DIA que tem zip da extracao aceita (`metodo.txt` em `METODOS_ACEITOS`), NUNCA a data de gravacao do blob: a
//   reextracao do historico grava dias antigos toda noite, e um vigia pela gravacao ficaria verde com a coleta do dia parada.
//
// O PRAZO (acordado com a sessao das coletas, 17/10/2026): o dia D tem de estar no cofre ate D+2 as 12:00 de Brasilia. A
//   ponte liga as 05:55 e leva o dia anterior; a folga de um dia cobre uma manha em que a VM nao conectou.
//
// ⚠️ COMPARA COM O RELOGIO, nunca com o proprio dado. Alerta UMA vez por evento (`soSeNova`: a issue aberta e a memoria) e
//    fecha quando o dia volta. NAO derruba o job: o alerta e a saida dele.
//
// Ambiente: DADOS_STORAGE, DB_CONTAINER (padrao backup-dados-scada), SECO=1 (nao alerta), e para alertar GITHUB_TOKEN e o e-mail.
'use strict';
const DB = require('./lib-scada-db');

const DB_CONTAINER = process.env.DB_CONTAINER || 'backup-dados-scada';
const SECO = /^(1|true|sim)$/i.test(process.env.SECO || '');
const BRT_MS = 3 * 3600 * 1000;
const PRAZO_MS = (2 * 24 + 12) * 3600 * 1000;   // D+2 12:00 BRT, contado do inicio do dia D
const OLHA_ATE = 8;                              // zips mais novos baixados para achar o ultimo aceito (~340 KB cada)

const pad2 = (n) => String(n).padStart(2, '0');
const diaUTC = (ms) => { const x = new Date(ms); return x.getUTCFullYear() + '-' + pad2(x.getUTCMonth() + 1) + '-' + pad2(x.getUTCDate()); };

// o dia mais novo cujo prazo ja venceu, no instante `agoraMs`: D tal que D 00:00 BRT + 2,5 dias <= agora
function exigido(agoraMs) { return diaUTC(agoraMs - BRT_MS - PRAZO_MS); }

// dias em ordem DECRESCENTE e o metodo de cada um -> o primeiro aceito (ou null)
function ultimoAceito(diasDesc, metodoDe) {
  for (const d of diasDesc) if (DB.METODOS_ACEITOS.includes(metodoDe(d))) return d;
  return null;
}

function julga(ultimo, agoraMs) {
  const ex = exigido(agoraMs);
  return { estado: ultimo != null && ultimo >= ex ? 'ok' : 'atrasado', exigido: ex, ultimo };
}

async function vigiar() {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const { alerta } = require('./lib-alerta');
  const cont = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(DB_CONTAINER);
  const nomes = [];
  for await (const b of cont.listBlobsFlat({ prefix: DB.PREFIXO })) nomes.push(b.name);
  const escolhidos = DB.escolhe(nomes);   // dia -> o zip MRT mais novo daquele dia
  const diasDesc = [...escolhidos.keys()].sort().reverse();
  const metodo = new Map();
  for (const d of diasDesc.slice(0, OLHA_ATE)) {
    const buf = await cont.getBlobClient(escolhidos.get(d)).downloadToBuffer();
    try { metodo.set(d, DB.leZip(buf, d, escolhidos.get(d)).metodo); } catch (e) { metodo.set(d, 'ilegivel: ' + e.message); }
  }
  const ultimo = ultimoAceito(diasDesc.slice(0, OLHA_ATE), (d) => metodo.get(d));
  const r = julga(ultimo, Date.now());
  const linhas = diasDesc.slice(0, OLHA_ATE).map((d) => '  ' + d + ' · ' + (metodo.get(d) || 'sem metodo.txt'));
  console.log('banco do supervisorio: ' + escolhidos.size + ' dia(s) com zip MRT · ultimo aceito ' + (ultimo || 'nenhum')
    + ' · exigido ' + r.exigido + ' (D+2 12:00 BRT) · ' + r.estado + '\n' + linhas.join('\n'));
  const chave = 'banco-parado:scada-db';
  if (SECO) return 0;
  if (r.estado === 'ok') {
    await alerta({ tipo: 'scada-db', chave, resolve: true, assunto: 'Banco do supervisório · normalizado',
      corpo: 'O cofre voltou a ter o dia ' + ultimo + ' da extração do banco do supervisório (exigido ' + r.exigido + ').' });
    return 0;
  }
  await alerta({ tipo: 'scada-db', chave, soSeNova: true,
    assunto: 'Banco do supervisório parado · último dia ' + (ultimo || 'nenhum') + ' (exigido ' + r.exigido + ')',
    corpo: [
      'O cofre não tem o zip do banco do supervisório (extração aceita) do dia **' + r.exigido + '**, que vencia em ' + r.exigido
        + ' + 2 dias às 12:00 de Brasília. Último dia aceito: **' + (ultimo || 'nenhum') + '**.',
      '',
      'O gerador do SCADA não falha por isso: ele republica o que já tinha, e o Comparativo e a tela do SCADA ficam no último dia.',
      '',
      'Os dias mais novos no cofre e o método de cada um:', linhas.join('\n'), '',
      'Onde olhar (sessão das coletas): a VM conectou pela ponte? A tarefa da coleta do SCADA_DB rodou? A extração gravou o',
      'metodo.txt da reta? O backup das 04:00 subiu a pasta SCADA_DB\\saida?',
    ].join('\n') });
  return 0;
}

module.exports = { exigido, ultimoAceito, julga, PRAZO_MS };

if (require.main === module) {
  // erro do PROPRIO vigia (cofre ilegivel, credencial) fica vermelho no job: vigia que cai calado e o defeito que ele combate
  vigiar().then((c) => process.exit(c)).catch((e) => { console.error('vigia do banco: ' + (e && e.stack || e)); process.exit(1); });
}
