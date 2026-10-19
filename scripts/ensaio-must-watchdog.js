/*
 * ensaio_vigia.js — exercita o vigia de MUST nos ramos que quase nunca rodam.
 *
 * O que importa num vigia e o caminho da FALHA. Ve-lo passar no caminho feliz nao prova nada —
 * foi exatamente assim que o painel de saude ficou seis horas dizendo 24/24 durante uma queda.
 *
 * Os cenarios saem de RECORTES REAIS do dia 23/08/2026, nao de dado inventado.
 * Uso:  node scripts/ensaio-must-watchdog.js       (todos)
 *       node scripts/ensaio-must-watchdog.js 1     (so o cenario 1)
 *
 * NAO grava blob, NAO dispara alerta: roda o vigia com LOCAL_OUT e sem credencial.
 * Sai 0 se os quatro cenarios rodarem; a conferencia e por LEITURA da saida — o valor dele e
 * mostrar o texto do alerta que um humano vai receber, que nenhuma asserção substitui.
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const { spawn } = require('child_process');

// 🔴 spawnSync BLOQUEIA o event loop do processo pai — e o servidor do recorte roda NESTE
// processo. Com ele, o filho pedia o JSON e ninguem atendia: os quatro cenarios davam ETIMEDOUT,
// inclusive o que ja tinha funcionado contra a URL real. O harness estava quebrado, nao o vigia.
const roda = (cmd, args, opts) => new Promise(ok => {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', d => out += d);
  c.stderr.on('data', d => err += d);
  const t = setTimeout(() => c.kill(), 60000);
  c.on('close', code => { clearTimeout(t); ok({ out, err, code }); });
});

const REPO = require('path').resolve(__dirname, '..');
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/must_5min.json';
const CACHE = require('os').tmpdir() + '/fixture_must5.json';

// Fase 2: o transporte e o da lib-le-dados (credencial para `dados`); o 404 e o erro da lib estouram, o fixture nao sai vazio
const baixa = () => require('./lib-le-dados').pede(BASE, { 'accept-encoding': 'gzip' }).then(r => {
  if (r.status !== 200) throw new Error('must_5min.json HTTP ' + r.status);
  let b = r.buf; if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return JSON.parse(b.toString('utf8'));
});

(async () => {
  let cheio;
  if (fs.existsSync(CACHE)) cheio = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  else { cheio = await baixa(); fs.writeFileSync(CACHE, JSON.stringify(cheio)); }
  const serie = cheio.serie || [];
  const corta = ate => ({ ...cheio, serie: serie.filter(l => l.t.slice(0, 19) <= ate) });

  // 🔴 O recorte por TEMPO trunca TODOS os parques — foi o erro do primeiro ensaio, que chamou de
  // "parcial" um cenario em que os nove sumiam. A queda parcial e OUTRA forma: os oito continuam
  // chegando e um so para. Reproduzo tirando a chave do M6 das linhas recentes, que e exatamente o
  // que o gerador faz quando a fonte devolve nulo para ele.
  const semParque = (p, desdeMin) => {
    const corte = Date.now() - desdeMin * 60000;
    return { ...cheio, serie: serie.map(l => {
      if (Date.parse(l.t) < corte) return l;
      const c = { ...l }; delete c[p]; delete c.Complexo; return c;
    }) };
  };

  const CEN = [
    ['1 · queda PARCIAL — so o M6 parou ha 4 h, oito reportando', semParque('M6', 240)],
    ['2 · queda TOTAL — ninguem reportando desde 02:10', corta('2026-08-23T02:10:00')],
    ['3 · NORMALIZADO — os nove frescos', cheio],
    ['4 · BLOB VAZIO — serie sem nenhuma linha', { ...cheio, serie: [] }],
  ];

  const so = process.argv[2];
  for (const [nome, blob] of CEN) {
    if (so && !nome.startsWith(so)) continue;
    const corpo = Buffer.from(JSON.stringify(blob));
    const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(corpo); });
    await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
    const porta = srv.address().port;
    console.log('\n══════ ' + nome + ' ══════');
    const r = await roda(process.execPath, ['scripts/gen-must-watchdog.js'], {
      cwd: REPO,
      env: { ...process.env, LOCAL_OUT: require('os').tmpdir() + require('path').sep, WAY2_TOKEN: '',
             FONTE_URL: 'http://127.0.0.1:' + porta + '/x.json',
             LIMIAR_MIN: '45', LIMIAR_EMAIL_MIN: '90' },
    });
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stdout.write('  [stderr] ' + r.err);
    console.log('  [saida do processo: ' + r.code + ']');
    await new Promise(ok => srv.close(ok));
  }
})();
