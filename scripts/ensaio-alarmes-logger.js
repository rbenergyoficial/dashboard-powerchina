'use strict';
/*
 * ensaio-alarmes-logger.js — os episódios de código de falha e de parada do inversor pelo logger Sungrow (lib-alarmes-logger.js), 29/10/2026.
 *
 * 1. O caso REAL (lido do cofre; LOGGER_DIR=<pasta Sungrow_dados do ano> lê de uma pasta): a conexão reversa da string no M2/TS1/INV06 e
 *    INV09, que a Sungrow mostrou no Logger4000 em 28/10/2026 17:54 (código 536, string 5). Os dois têm o 536 a partir de 17:55 de 28/10,
 *    com a potência de entrada perto de zero; o código que entrou na noite de 27/10 costura com o da madrugada de 28/10 e tem fim. A
 *    posição sai do sg_ident.json publicado (LOCAL_IDENT=<arquivo>). Dia fixo que sumiu REPROVA, não pula.
 * 2. Linhas FORJADAS: a costura da virada; a amostra ilegível no meio não corta; troca de código abre episódio novo; a parada por chave
 *    com 0xFFFE no meio; o 0x5500 (com código) não vira parada; o grupo de 3 inversores do M7 com o código 10; o inversor sem posição
 *    fica fora do grupo; o dia sem leitura no meio dá fim aproximado (`fx`); no inversor-dia de dois zips fica o de mais amostras; a
 *    faixa do nome do zip, inclusive na virada do ano; a janela corta o que terminou antes.
 * Depois PLANTA defeitos numa cópia da lib e exige que cada um reprove.
 * uso: node scripts/ensaio-alarmes-logger.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), os = require('os'), path = require('path');
const LIB = path.join(__dirname, 'lib-alarmes-logger.js');
const S = require('./lib-sungrow.js');
const C = require('./lib-sungrow-cofre.js');
const { entradas } = require('./lib-zip.js');

// ---- o caso real ----
const GRUPO_REAL = 'M02/TS01/06 A 10/', DIAS_REAIS = ['27.10 A 27.10.zip', '28.10 A 28.10.zip'], ANO_REAL = '2026';
const POS_REAIS = ['M2/TS1/INV06', 'M2/TS1/INV09'];
async function leReal() {
  const out = [];
  if (process.env.LOGGER_DIR) {
    for (const n of DIAS_REAIS) {
      const f = path.join(process.env.LOGGER_DIR, GRUPO_REAL, n);
      if (!fs.existsSync(f)) throw new Error('o zip fixo ' + GRUPO_REAL + n + ' não está em ' + process.env.LOGGER_DIR + ': reprova');
      out.push({ nome: GRUPO_REAL + n, buf: fs.readFileSync(f) });
    }
  } else {
    const c = require('./lib-conteiner').conteiner(process.env.COFRE || C.COFRE), Lc = [];
    for await (const b of c.listBlobsFlat({ prefix: C.PREFIXO + ANO_REAL + '/' + GRUPO_REAL })) Lc.push({ name: b.name, size: b.properties.contentLength, lastModified: b.properties.lastModified });
    const M = C.mapeia(Lc);
    for (const n of DIAS_REAIS) {
      const z = M.zips.get(GRUPO_REAL + n);
      if (!z) throw new Error('o zip fixo ' + GRUPO_REAL + n + ' não está no cofre: reprova');
      out.push({ nome: GRUPO_REAL + n, buf: await c.getBlobClient(z.fonte).downloadToBuffer() });
    }
  }
  const csvs = [];
  for (const z of out) for (const e of entradas(z.buf, z.nome)) {
    const m = e.nome.match(/HIS_([^_]+(?:_\d+)?)_\d{12}_\d{12}\.csv$/i);
    if (!m) continue;
    const { cab, linhas } = S.le(e.dados.toString('utf8'));
    if (linhas.length && S.tipo(cab) === 'inversor') csvs.push({ sn: m[1], cab, linhas, onde: z.nome + '/' + e.nome });
  }
  return csvs;
}
async function leIdent() {
  if (process.env.LOCAL_IDENT) return JSON.parse(fs.readFileSync(process.env.LOCAL_IDENT, 'utf8')).ident;
  const LD = require('./lib-le-dados');
  const j = await LD.json(LD.BASE + 'sg_ident.json');
  if (!j || !j.ident) throw new Error('sg_ident.json ausente: reprova');
  return j.ident;
}

// ---- forjados ----
const CAB = ['Tempo', 'Código de falha', 'Status do dispositivo', 'Potência ativa total'];
// [hh:mm, código ('' = ilegível), estado, potência W]
const linhas = (d, a) => a.map(([t, c, s, p]) => [d + ' ' + t + ':00', String(c), String(s), String(p)]);
const serie = (d, ini, fim, c, s, p) => { const o = []; for (let m = ini; m <= fim; m += 5) o.push([String(m / 60 | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'), c, s, p]); return o; };
const hm = (h, m) => h * 60 + m;
const D1 = '2026-09-10', D2 = '2026-09-11', D3 = '2026-09-12', D4 = '2026-09-13';

function casos(L, real, identReal) {
  const f = [];
  const C2 = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const doEv = (o, t, m) => o.ev.filter((e) => e.t === t && (!m || o.msg[e.m] === m));

  // 1 · o caso real
  const armR = L.armVazio();
  for (const x of real) L.junta(armR, x.sn, 'M2', L.diaAlarmes(x.cab, x.linhas, x.onde));
  const r = L.compoe([armR], identReal, '2026-10-27', '2026-10-28', { gerado: 'ensaio' });
  for (const pos of POS_REAIS) {
    const e536 = doEv(r, pos, 'reversa_fv').find((e) => e.v === 536 && e.i.startsWith('2026-10-28T17:5'));
    C2('real: ' + pos + ' com 536 (string 5) a partir de 28/10 ~17:55, com o inversor quase sem geração', e536 && e536.s === 5 && e536.c === 'inversor_alarme' && e536.pk != null && e536.pk < 5,
      JSON.stringify(doEv(r, pos)));
    const noite = doEv(r, pos, 'reversa_fv').find((e) => e.i.startsWith('2026-10-27T1'));
    C2('real: ' + pos + ' o código da noite de 27/10 costura com a madrugada de 28/10 e tem fim', noite && noite.f && noite.f.startsWith('2026-10-28T0'), JSON.stringify(noite));
  }

  // 2 · forjados
  const ident = { A: { pos: 'M2/TS1/INV06' }, G1: { pos: 'M7/TS1/INV01' }, G2: { pos: 'M7/TS1/INV02' }, G3: { pos: 'M7/TS2/INV05' }, B: { pos: 'M5/TS3/INV10' }, P: { pos: 'M3/TS2/INV04' } };
  const arm = L.armVazio();
  const poe = (sn, u, d, a) => L.junta(arm, sn, u, L.diaAlarmes(CAB, linhas(d, a), 'forjado ' + sn));
  // A: 536 das 17:55 de D1 até 06:25 de D2 (costura); em D2, 532 10:00 · ilegível 10:05 · 532 10:10 · 0 10:15; 532 → 534 às 18:00
  poe('A', 'M2', D1, [...serie(D1, 0, hm(17, 50), 0, 0, 100000), ...serie(D1, hm(17, 55), hm(23, 55), 536, 0x9100, 0)]);
  poe('A', 'M2', D2, [...serie(D2, 0, hm(6, 25), 536, 0x9100, 0), ...serie(D2, hm(6, 30), hm(9, 55), 0, 0, 50000),
    ['10:00', 532, 0x9100, 90000], ['10:05', '', 0x9100, 90000], ['10:10', 532, 0x9100, 90000], ...serie(D2, hm(10, 15), hm(17, 55), 0, 0, 90000),
    ['18:00', 532, 0x9100, 0], ['18:05', 534, 0x9100, 0], ['18:10', 0, 0, 0]]);
  // P: parada por chave 07:00 com 0xFFFE às 07:05, de volta às 07:15; falha 0x5500 com código 38 às 09:00
  poe('P', 'M3', D1, [['06:55', 0, 0, 1000], ['07:00', 0, 0x1300, 0], ['07:05', 0, 0xFFFE, 0], ['07:10', 0, 0x1300, 0], ['07:15', 0, 0, 1000],
    ['09:00', 38, 0x5500, 0], ['09:05', 0, 0, 1000]]);
  // G1, G2, G3 e C (sem posição, mesma usina): código 10 às 17:10–17:15
  for (const [sn, t] of [['G1', '17:10'], ['G2', '17:15'], ['G3', '17:15'], ['Cx', '17:15']]) poe(sn, 'M7', D1, [['17:05', 0, 0, 1000], [t, 10, 0x5500, 0], ['17:40', 0, 0, 0]]);
  // B: código aberto no fim de D1, D2 sem leitura, D3 começa sem código
  poe('B', 'M5', D1, [['23:50', 0, 0, 0], ['23:55', 39, 0x5500, 0]]);
  poe('B', 'M5', D3, [['00:00', 0, 0x1400, 0], ['00:05', 0, 0x1400, 0]]);
  const o = L.compoe([arm], ident, D1, D3, { gerado: 'ensaio' });
  const a536 = doEv(o, 'M2/TS1/INV06').filter((e) => e.v === 536);
  C2('costura: o 536 de D1 17:55 vai até D2 06:30, um episódio só', a536.length === 1 && a536[0].i === D1 + 'T17:55:00' && a536[0].f === D2 + 'T06:30:00' && a536[0].s === 5, JSON.stringify(a536));
  const a532 = doEv(o, 'M2/TS1/INV06').filter((e) => e.v === 532);
  C2('ilegível no meio não corta: 532 de 10:00 a 10:15 é um episódio; 532 → 534 às 18:05 abre outro', a532.length === 2 && a532[0].i === D2 + 'T10:00:00' && a532[0].f === D2 + 'T10:15:00'
    && a532[1].f === D2 + 'T18:05:00' && doEv(o, 'M2/TS1/INV06').some((e) => e.v === 534 && e.i === D2 + 'T18:05:00' && e.f === D2 + 'T18:10:00'), JSON.stringify(a532));
  const pa = doEv(o, 'M3/TS2/INV04').filter((e) => e.c === 'inversor_parada');
  C2('parada por chave 07:00–07:15 com 0xFFFE no meio; o 0x5500 não é parada', pa.length === 1 && o.msg[pa[0].m] === 'parada_chave' && pa[0].i === D1 + 'T07:00:00' && pa[0].f === D1 + 'T07:15:00',
    JSON.stringify(pa));
  C2('o 0x5500 vem como o código (38, falha do sistema)', doEv(o, 'M3/TS2/INV04').some((e) => e.v === 38 && e.c === 'inversor_falha' && o.msg[e.m] === 'falha_sistema'));
  const g = o.ev.filter((e) => e.t === 'M7' && e.inv);
  C2('grupo: código 10 em 3 inversores do M7 = um grupo, sem o inversor sem posição', g.length === 1 && JSON.stringify(g[0].inv) === JSON.stringify({ TS1: ['01', '02'], TS2: ['05'] })
    && g[0].k === 3 && g[0].c === 'inversor_falha' && o.msg[g[0].m] === 'ilhamento' && g[0].o === 'rede' && g[0].v === 10, JSON.stringify(g));
  C2('sem posição: fica com a tag SN: e entra em sem_posicao', o.ev.some((e) => e.t === 'SN:Cx' && e.v === 10) && o.sem_posicao.includes('Cx') && o.eq['SN:Cx'] && o.eq['SN:Cx'].u === 'M7');
  const b = doEv(o, 'M5/TS3/INV10');
  C2('dia sem leitura no meio: fim no 00:00 do próximo dia lido, marcado fx', b.length === 1 && b[0].f === D3 + 'T00:00:00' && b[0].fx === 1, JSON.stringify(b));
  const j = L.compoe([arm], ident, D3, D4, { gerado: 'ensaio' });
  C2('janela: o que terminou antes fica fora', !j.ev.some((e) => e.t === 'M7' || e.t === 'M2/TS1/INV06') && j.ev.some((e) => e.t === 'M5/TS3/INV10'), JSON.stringify(j.ev.map((e) => e.t)));
  // mais amostras ganha
  const a2 = L.armVazio();
  L.junta(a2, 'Z', 'M1', [{ d: D1, n: 100, ev: [[532, '18:00', null, 0, 0]], st: [] }]);
  L.junta(a2, 'Z', 'M1', [{ d: D1, n: 50, ev: [], st: [] }]);
  const k1 = a2.dias[D1].Z.n;
  L.junta(a2, 'Z', 'M1', [{ d: D1, n: 200, ev: [], st: [] }]);
  C2('dois zips do mesmo inversor-dia: fica o de mais amostras', k1 === 100 && a2.dias[D1].Z.n === 200 && !a2.dias[D1].Z.ev, k1 + ' ' + JSON.stringify(a2.dias[D1].Z));
  // faixa do nome
  const fx = [L.faixaDoZip('M05/TS01/01 A 05/28.10 A 28.10.zip', 2026), L.faixaDoZip('M05/TS01/01 A 05/28.12 A 03.01 rec.zip', 2027), L.faixaDoZip('M05/TS01/01 A 05/x.zip', 2026)];
  C2('faixa do zip: o dia, a virada do ano e o nome fora da forma', JSON.stringify(fx) === JSON.stringify([['2026-10-28', '2026-10-28'], ['2026-12-28', '2027-01-03'], null]), JSON.stringify(fx));
  return f;
}

(async () => {
  const real = await leReal(), identReal = await leIdent();
  for (const p of POS_REAIS) if (!Object.values(identReal).some((x) => x.pos === p)) throw new Error(p + ' sem série no sg_ident.json: reprova');
  const base = casos(require(LIB), real, identReal);
  if (base.length) { console.log('🔴 a lib real reprova:'); base.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('✅ lib real: todos os casos passam');
  const SRC = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
  const PLANTIOS = [
    ['sem costura da virada', 'if (a0 && ant && ant.d === diaMais(d, -1))', 'if (false)'],
    ['a amostra ilegível corta o episódio', '    if (x == null) continue;', '    if (x == null) { if (cur) { cur.fim = t; out.push(cur); cur = null; } continue; }'],
    ['o 0xFFFE encerra a parada', 'x == null || x === INVALIDO ? null : x', 'x == null ? null : x'],
    ['o 0x5500 vira parada', "[0x2500, 'falha_comunicacao']]", "[0x2500, 'falha_comunicacao'], [0x5500, 'falha']]"],
    ['sem grupo', 'const GRUPO_N = 3,', 'const GRUPO_N = 1e9,'],
    ['o inversor sem posição entra no grupo', 'eps.filter((x) => x.pos)', 'eps.filter((x) => true)'],
    ['sem o número da string', 's: f.string', 's: undefined'],
    ['fica o de menos amostras', 'if (a && a.n >= x.n) continue;', 'if (a && a.n <= x.n) continue;'],
    ['sem a marca de fim aproximado', 'if (ant.d !== diaMais(d, -1)) ant.e.fx = 1;', ''],
    ['a virada do ano no nome do zip', '(m[2] > m[4] ? ano - 1 : ano)', 'ano'],
    ['a janela não corta', 'if ((e.f || fimJ) < iniJ || e.i > fimJ) continue;', ''],
    ['sem a potência de entrada', 'kw(e.k), e.a0', 'null, e.a0'],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-alarmes-logger-'));
  let ruim = 0;
  try {
    for (const lib of ['lib-sungrow.js', 'lib-contador-dia.js']) fs.copyFileSync(path.join(__dirname, lib), path.join(tmp, lib));
    PLANTIOS.forEach(([nome, de, para], k) => {
      if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
      const arq = path.join(tmp, 'lib-' + k + '.js');
      fs.writeFileSync(arq, SRC.replace(de, para));
      let f; try { f = casos(require(arq), real, identReal); } catch (e) { f = ['estourou: ' + e.message]; }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 160) + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
  console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
})().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
