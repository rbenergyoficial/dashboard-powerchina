// Ensaio da lib de alerta. Ele exercita os tres estados que o canal precisa acertar — abrir,
// comentar e fechar — contra um GitHub SIMULADO, e prova a propriedade que faz o dedup funcionar:
// o mesmo evento produz sempre o MESMO titulo.
//
// 🔴 POR QUE SIMULADO: um ensaio que abrisse issue de verdade a cada execucao encheria o
//    repositorio de ruido — e ruido no canal de alerta e exatamente o defeito que o dedup existe
//    para evitar. O que se prova aqui e a LOGICA; o caminho de rede e o mesmo `https` que os
//    outros vigias ja usam em producao.
'use strict';
const Module = require('module');
const path = require('path');

let mau = 0;
const ok = (c, m) => { if (!c) { mau += 1; console.log('  [X] ' + m); } else console.log('  ok  ' + m); };

// ── GitHub simulado: guarda as issues em memoria e responde como a API ──────────────────────
const estado = { issues: [], chamadas: [], getFalha: 0 };
const httpsFalso = {
  request(op, cb) {
    const corpo = [];
    return {
      on() { return this; },
      write(d) { corpo.push(d); },
      end() {
        let body = null;
        if (corpo.length) { const s = corpo.join(''); try { body = JSON.parse(s); } catch (e) { body = s; } }   // o pedido do token e form-urlencoded
        estado.chamadas.push({ metodo: op.method, caminho: op.path, body });
        let resp = null, status = 200;
        const p = op.path;
        // o caminho do e-mail (caso 9): o token de identidade do GitHub, a troca no Entra e o sendMail do Graph
        if (/^oidc\./.test(op.hostname || '')) resp = { value: 'id-token-de-ensaio' };
        else if (op.hostname === 'login.microsoftonline.com') resp = { access_token: 'token-graph-de-ensaio' };
        else if (op.hostname === 'graph.microsoft.com') status = 202;
        else if (op.method === 'GET' && /\/issues\?/.test(p) && estado.getFalha) {
          resp = { message: 'Server Error' }; status = estado.getFalha;
        } else if (op.method === 'GET' && /\/issues\?/.test(p)) {
          // paginado como a API: 100 por pagina, na ordem em que foram abertas (a mais nova primeiro)
          const pg = Number((/[?&]page=(\d+)/.exec(p) || [])[1] || 1);
          resp = estado.issues.filter((i) => i.state === 'open').slice().reverse().slice((pg - 1) * 100, pg * 100);
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
        const res = { statusCode: status, resume() {}, on(ev, f) {
          if (ev === 'data') f(Buffer.from(JSON.stringify(resp)));
          if (ev === 'end') f(); return res; } };
        cb(res);
      },
    };
  },
};

// injeta o https falso so para o modulo da lib
const originalLoad = Module._load;
Module._load = function (req, pai, isMain) {
  if (req === 'https' && pai && /lib-alerta\.js$/.test(pai.filename)) return httpsFalso;
  return originalLoad.apply(this, arguments);
};
process.env.GH_TOKEN = 'token-de-ensaio';
process.env.PA_ALERT_WEBHOOK = '';              // sem webhook: o ensaio mede so a issue
delete require.cache[require.resolve('./lib-alerta.js')];
const { alerta, tituloDe, texto } = require(path.join(__dirname, 'lib-alerta.js'));
Module._load = originalLoad;

(async () => {
  console.log('1 · a chave produz titulo ESTAVEL (e o que faz o dedup funcionar)');
  const t1 = tituloDe({ chave: 'cadencia:must-intra.yml', titulo: 'must-intra.yml fora da cadencia' });
  const t2 = tituloDe({ chave: 'cadencia:must-intra.yml', titulo: 'must-intra.yml fora da cadencia' });
  ok(t1 === t2, 'duas chamadas, mesmo titulo: ' + t1);
  const t3 = tituloDe({ chave: 'cadencia:way2-agg.yml', titulo: 'way2-agg.yml fora da cadencia' });
  ok(t1 !== t3, 'workflows diferentes, titulos diferentes');

  console.log('\n2 · abrir · comentar · fechar');
  const evento = { tipo: 'relogio_atrasado', chave: 'cadencia:must-intra.yml',
    titulo: 'must-intra.yml fora da cadencia', assunto: 'x',
    corpo: '<b>must-intra.yml</b> esta fora da cadencia.<br>Sem rodar ha 90 min.' };

  const a = await alerta(evento);
  ok(/abriu #1/.test(a.issue), 'primeira vez ABRE a issue (' + a.issue + ')');
  ok(estado.issues.length === 1, 'uma issue no repositorio');

  const b = await alerta(evento);
  ok(/comentou #1/.test(b.issue), 'segunda vez COMENTA, nao abre outra (' + b.issue + ')');
  ok(estado.issues.length === 1, '🔴 continua UMA issue — o dedup e o que evita ruido a cada 5 min');

  const c = await alerta({ ...evento, tipo: 'relogio_normalizado', resolve: true,
    corpo: '<b>voltou</b>' });
  ok(/fechou #1/.test(c.issue), 'normalizar FECHA a issue (' + c.issue + ')');
  ok(estado.issues[0].state === 'closed', 'a issue ficou fechada');

  const d = await alerta(evento);
  ok(/abriu #2/.test(d.issue), 'depois de fechada, um evento NOVO abre outra (' + d.issue + ')');

  console.log('\n3 · o corpo vira texto legivel');
  const tx = texto('<b>a</b><br>b<ul><li>c</li></ul>&amp;');
  ok(!/[<>]/.test(tx) && /a\nb/.test(tx) && /- c/.test(tx), 'html simples -> texto: ' + JSON.stringify(tx));

  console.log('\n4 · o alerta carrega os campos do evento, nao so o texto');
  const ult = estado.issues[1] ? estado.chamadas.filter((x) => x.metodo === 'POST').pop() : null;
  ok(ult && /relogio_atrasado/.test(ult.body.body), 'o corpo da issue traz o tipo do evento');

  console.log('\n5 · `soSeNova`: o evento ja aberto nao aciona canal nenhum (o vigia sem o estado, 11/10/2026)');
  const ev5 = { tipo: 'vigia_estado_ilegivel', chave: 'vigia:estado', titulo: 'vigia sem o estado dos alarmes', assunto: 'x',
    corpo: 'o vigia nao le o estado', soSeNova: true };
  const e1 = await alerta(ev5);
  ok(/abriu #/.test(e1.issue), 'primeira vez ABRE (' + e1.issue + ')');
  const nCham = estado.chamadas.length;
  const e2 = await alerta(ev5);
  ok(/ja aberta #/.test(e2.issue), 'segunda vez nao abre nem comenta (' + e2.issue + ')');
  ok(estado.chamadas.slice(nCham).every((x) => x.metodo === 'GET'), 'so consultou: nenhum POST nem PATCH');
  const e3 = await alerta({ ...ev5, tipo: 'vigia_estado_legivel', resolve: true, corpo: 'voltou' });
  ok(/fechou #/.test(e3.issue), '`resolve` com `soSeNova` continua fechando (' + e3.issue + ')');
  const e4 = await alerta(ev5);
  ok(/abriu #/.test(e4.issue), 'fechada, o evento seguinte abre de novo (' + e4.issue + ')');
  const semOpcao = await alerta({ ...ev5, soSeNova: false });
  ok(/comentou #/.test(semOpcao.issue), 'sem a opcao, o comportamento de antes: comenta (' + semOpcao.issue + ')');

  console.log('\n6 · `soSeNova` com a consulta de issues FORA (HTTP 500): avisa assim mesmo, e diz que a issue falhou');
  estado.getFalha = 500;
  const e6 = await alerta({ ...ev5, chave: 'vigia:estado6', titulo: 'outro evento' });
  estado.getFalha = 0;
  ok(/^FALHOU/.test(e6.issue), 'a issue diz FALHOU, nao "ja aberta" (' + e6.issue + ')');
  ok(!/ja aberta/.test(e6.issue), 'fail-open: a falha da consulta nao vira dedup');

  console.log('\n7 · a issue do evento fora da primeira pagina (mais de 100 abertas) ainda e achada');
  for (let k = 0; k < 120; k++) await alerta({ tipo: 't', chave: 'enchimento:' + k, titulo: 'enchimento ' + k, assunto: 'x', corpo: 'x' });
  const nCh7 = estado.chamadas.length;
  const e7 = await alerta(ev5);
  ok(/ja aberta #/.test(e7.issue), 'o evento aberto antes das 120 segue achado (' + e7.issue + ')');
  ok(estado.chamadas.slice(nCh7).every((x) => x.metodo === 'GET'), 'e nada foi aberto nem comentado');

  console.log('\n8 · `corpoEmail` (o detalhe so para o destinatario) nunca chega a issue publica');
  const nCh8 = estado.chamadas.length;
  await alerta({ tipo: 'vencimento', chave: 'vencimento:teste8', titulo: 'credencial a vencer (teste8)', assunto: 'x',
    corpo: 'texto publico', corpoEmail: 'SEGREDO-DO-EMAIL conta-x conteiner-y' });
  const posts8 = estado.chamadas.slice(nCh8).filter((x) => x.metodo === 'POST').map((x) => JSON.stringify(x.body));
  ok(posts8.length > 0 && posts8.every((b) => b.indexOf('SEGREDO-DO-EMAIL') < 0 && b.indexOf('corpoEmail') < 0),
    'o corpo e o JSON da issue nao levam o corpoEmail (' + posts8.length + ' POST)');

  console.log('\n9 · o e-mail sai, e o destinatario NAO vai ao retorno nem ao log publico (lib-alerta-destino, 03/11/2026)');
  // 🔴 o log do Actions e publico (o repositorio e publico): o endereco de quem recebe o alerta nao pode aparecer nele
  Object.assign(process.env, { AZ_MAIL_TENANT_ID: 'tenant-de-ensaio', AZ_MAIL_CLIENT_ID: 'cliente-de-ensaio', MAIL_DE: 'de@ensaio.test',
    MAIL_PARA: 'pessoa-secreta@ensaio.test', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.ensaio.test/token?x=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-de-ensaio' });
  Module._load = function (req, pai) {
    if (req === 'https' && pai && /lib-alerta\.js$/.test(pai.filename)) return httpsFalso;
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('./lib-alerta.js')];
  const L9 = require(path.join(__dirname, 'lib-alerta.js'));   // de novo: a lib le o MAIL_* ao carregar
  Module._load = originalLoad;
  const linhas9 = [], log0 = console.log;
  console.log = (...a) => { linhas9.push(a.join(' ')); };
  let r9;
  try { r9 = await L9.alerta({ tipo: 't9', chave: 'ensaio:destino9', titulo: 'destino 9', assunto: 'x', corpo: 'x' }); }
  finally { console.log = log0; }
  const envio9 = estado.chamadas.filter((x) => /\/sendMail$/.test(x.caminho)).pop();
  ok(envio9 && JSON.stringify(envio9.body).indexOf('pessoa-secreta@ensaio.test') >= 0, 'o Graph recebeu o pedido com o destinatario');
  ok(/^enviado/.test(r9.email), 'o canal diz que enviou (' + r9.email + ')');
  ok(JSON.stringify(r9).indexOf('pessoa-secreta') < 0, '🔴 o retorno do alerta nao leva o endereco');
  ok(linhas9.length > 0 && linhas9.every((l) => l.indexOf('pessoa-secreta') < 0), '🔴 a linha do log nao leva o endereco');

  console.log('\n' + (mau ? '[X] ' + mau + ' problemas' : 'abrir, comentar e fechar funcionam, e o dedup segura o ruido'));
  process.exit(mau ? 1 : 0);
})().catch((e) => { console.log('ERRO ' + e.message); process.exit(1); });
