// Ensaio do CANAL do vigia da Way2 — prova que os quatro eventos dele deduplicam e fecham.
//
// 🔴 O QUE ESTA SENDO PROVADO, E POR QUE
// O `gen-way2-watchdog.js` passou a falar pelo `lib-alerta`, que ACRESCENTA uma issue no
// repositorio ao webhook do Power Automate. Ele vigia a UNICA entrada de dado do ao-vivo, entao
// o canal dele nao pode ter dois modos de falhar:
//
//   chave que MUDA          → abre uma issue nova a cada lembrete, e issue a cada lembrete
//                             ensina a ignorar a issue;
//   chave DESEMPARELHADA    → a normalizacao nao acha a issue da falha e nunca fecha nada, e o
//                             repositorio acumula alarme aberto de coisa que ja voltou.
//
// ⚠️ As chaves saem do CODIGO-FONTE do vigia, nao de uma copia escrita aqui. Um ensaio que
//    redigitasse `way2:telemetria` provaria que a constante do ensaio bate com ela mesma.
//
// 🔴 GitHub SIMULADO: um ensaio que abrisse issue de verdade a cada execucao encheria o
//    repositorio do ruido que o dedup existe para evitar.
'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let mau = 0;
const ok = (c, m) => { if (!c) { mau += 1; console.log('  [X] ' + m); } else console.log('  ok  ' + m); };

// ── as chaves, extraidas do vigia COMO ELE SOBE ────────────────────────────────────────────
// ⚠️ `WATCHDOG_SRC` existe para o ensaio NEGATIVO: um teste que so foi visto passando nao esta
//    testado. Com ele se aponta para uma copia quebrada de proposito e se confere que o ensaio
//    reprova. Em uso normal fica vazio e le o arquivo de verdade.
const ALVO = process.env.WATCHDOG_SRC || path.join(__dirname, 'gen-way2-watchdog.js');
const fonte = fs.readFileSync(ALVO, 'utf8');
function evDo(nome) {
  const m = new RegExp('const ' + nome + ' = (\\{[^}]*\\});').exec(fonte);
  if (!m) throw new Error(nome + ' nao encontrado em gen-way2-watchdog.js');
  return new Function('return ' + m[1] + ';')();
}
const EV_TELEMETRIA = evDo('EV_TELEMETRIA');
const EV_MEDIDOR = evDo('EV_MEDIDOR');

// e a funcao de entrega, tambem do fonte
const mEnt = /const entregou = \(r\) =>[\s\S]*?\n\}\);/.exec(fonte);
if (!mEnt) throw new Error('entregou() nao encontrada em gen-way2-watchdog.js');
const entregou = new Function('return ' + mEnt[0].replace(/^const entregou = /, '').replace(/;$/, '') + ';')();

// ── GitHub simulado ────────────────────────────────────────────────────────────────────────
const estado = { issues: [] };
const httpsFalso = {
  request(op, cb) {
    const corpo = [];
    return {
      on() { return this; },
      write(d) { corpo.push(d); },
      end() {
        const body = corpo.length ? JSON.parse(corpo.join('')) : null;
        let resp = null; let status = 200;
        const p = op.path;
        if (op.method === 'GET' && /\/issues\?/.test(p)) {
          resp = estado.issues.filter((i) => i.state === 'open');
        } else if (op.method === 'POST' && /\/issues$/.test(p)) {
          const i = { number: estado.issues.length + 1, title: body.title, state: 'open', comentarios: [] };
          estado.issues.push(i); resp = i; status = 201;
        } else if (op.method === 'POST' && /\/issues\/(\d+)\/comments$/.test(p)) {
          const n = Number(p.match(/\/issues\/(\d+)\//)[1]);
          (estado.issues.find((i) => i.number === n) || { comentarios: [] }).comentarios.push(body.body);
          resp = {}; status = 201;
        } else if (op.method === 'PATCH' && /\/issues\/(\d+)$/.test(p)) {
          const n = Number(p.match(/\/issues\/(\d+)$/)[1]);
          const i = estado.issues.find((x) => x.number === n); if (i) i.state = body.state;
          resp = i || {};
        }
        const res = { statusCode: status, resume() {},
          on(ev, f) { if (ev === 'data') f(Buffer.from(JSON.stringify(resp))); if (ev === 'end') f(); return res; } };
        cb(res);
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function (req, pai) {
  if (req === 'https' && pai && /lib-alerta\.js$/.test(pai.filename)) return httpsFalso;
  return originalLoad.apply(this, arguments);
};
process.env.GH_TOKEN = 'token-de-ensaio';
process.env.PA_ALERT_WEBHOOK = '';   // sem webhook: o ensaio mede so a issue
delete require.cache[require.resolve('./lib-alerta.js')];
const { alerta, tituloDe } = require(path.join(__dirname, 'lib-alerta.js'));
Module._load = originalLoad;

const abertas = () => estado.issues.filter((i) => i.state === 'open');
const acha = (t) => estado.issues.find((i) => i.title === t);

(async () => {
  console.log('1 · os dois eventos do vigia sao DISTINTOS entre si');
  const tTel = tituloDe(EV_TELEMETRIA);
  const tMed = tituloDe(EV_MEDIDOR);
  console.log('     telemetria: ' + tTel);
  console.log('     medidores : ' + tMed);
  ok(tTel !== tMed, 'telemetria e medidores nao compartilham issue');

  console.log('\n2 · o LEMBRETE nao abre issue nova — o assunto muda, o titulo nao');
  await alerta({ tipo: 'falha', ...EV_TELEMETRIA, assunto: 'sem dados ha 61 min', corpo: 'a' });
  ok(abertas().length === 1, 'primeiro aviso abriu 1 issue');
  await alerta({ tipo: 'falha', ...EV_TELEMETRIA, assunto: 'sem dados ha 4 h', corpo: 'b' });
  await alerta({ tipo: 'falha', ...EV_TELEMETRIA, assunto: 'sem dados ha 11 h', corpo: 'c' });
  ok(abertas().length === 1, 'dois lembretes depois, continua 1 issue aberta');
  ok(acha(tTel).comentarios.length === 2, 'os lembretes viraram 2 comentarios');

  console.log('\n3 · a NORMALIZACAO fecha a issue da falha');
  await alerta({ tipo: 'normalizado', ...EV_TELEMETRIA, resolve: true, assunto: 'voltou', corpo: 'd' });
  ok(acha(tTel).state === 'closed', 'a issue da telemetria foi fechada');
  ok(abertas().length === 0, 'nada aberto sobrou');

  console.log('\n4 · o evento de MEDIDOR corre em paralelo, sem se confundir');
  await alerta({ tipo: 'medidor_fora', ...EV_MEDIDOR, assunto: '2 medidores fora', corpo: 'e' });
  await alerta({ tipo: 'falha', ...EV_TELEMETRIA, assunto: 'caiu de novo', corpo: 'f' });
  ok(abertas().length === 2, 'dois eventos simultaneos, duas issues');
  await alerta({ tipo: 'medidor_normalizado', ...EV_MEDIDOR, resolve: true, assunto: 'voltaram', corpo: 'g' });
  ok(abertas().length === 1, 'fechar o de medidor nao fecha o de telemetria');
  ok(abertas()[0].title === tTel, 'a que sobrou aberta e a da telemetria');

  console.log('\n5 · entregou() le a resposta do lib-alerta');
  ok(entregou({ webhook: '-', issue: 'abriu #3' }), 'so a issue basta (webhook desligado)');
  ok(entregou({ webhook: 'HTTP 202', issue: '-' }), 'so o webhook basta (issue desligada)');
  ok(entregou({ webhook: 'FALHOU: x', issue: 'comentou #3' }), 'um canal falhou, o outro entregou');
  ok(!entregou({ webhook: '-', issue: '-' }), 'nenhum canal configurado: NAO entregue');
  ok(!entregou({ webhook: 'FALHOU: x', issue: 'FALHOU: y' }), 'os dois falharam: NAO entregue');
  ok(!entregou({ webhook: '-', issue: 'nada aberto para fechar' }),
    'fechar o que nao existe nao conta como entrega');

  console.log('\n' + (mau ? mau + ' FALHA(S)' : 'tudo passou'));
  process.exit(mau ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
