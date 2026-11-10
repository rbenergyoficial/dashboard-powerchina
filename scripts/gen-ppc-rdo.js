/*
 * gen-ppc-rdo.js — o registro das ordens do operador nacional pelo RDO do SIGO, ao lado do da planilha da mesa.
 *   `ppc_restricao_rdo.json` (o mesmo formato do `ppc_restricao.json`) e `ppc_paralelo.json` (dia a dia, planilha × RDO).
 *
 * A planilha da mesa deixa de ser a fonte do PPC (humano, 26/10/2026: "a planilha da mesa deixa de existir"; 01/11/2026, pela auditoria de
 * automação: o PPC passa a ler a aba Restrições do RDO). Antes de trocar, 7 dias seguidos em PARALELO sem divergência (aprovado pelo
 * humano em 26/10/2026): este gerador NÃO mexe no `ppc_restricao.json` nem nos que o leem; ele publica a versão do RDO e o comparativo.
 *
 * ── DE ONDE VEM ──────────────────────────────────────────────────────────────────
 *   o RDO:      `rdo_ordens.json` no contêiner `indicadores` do armazenamento do SIGO Gestão, publicado pelo próprio Gestão a cada mudança
 *               (só leitura, pelo OIDC do job: lib-conteiner.conteinerEm). Fatos sem nome de pessoa.
 *   a planilha: o `ppc_restricao.json` publicado (lib-le-dados), só para o comparativo.
 *   LOCAL_RDO=<arquivo> e LOCAL_PPC=<arquivo> leem do disco (é o modo do ensaio); LOCAL_OUT_DIR grava no disco em vez de publicar.
 *
 * ── COMO VIRA EVENTO ─────────────────────────────────────────────────────────────
 *   cada ordem do RDO é um evento no minuto dela: a liberação vale a potência plena (restr 0, motivo LIVRE); a ordem e a alteração valem o
 *   limite do conjunto (restr 1) com o código do motivo do RDO. A ordem herdada do RDO anterior entra às 00:00, marcada `herdada: 1`.
 *   Cenário e turno eram campos só da planilha: ficam vazios, não se inventam. O técnico não vai (o arquivo do Gestão não leva nome):
 *   no lugar, a origem ("coleta" ou "mesa") e a conferência ("sistema", "mesa", "corrigida").
 *
 * ── O COMPARATIVO ────────────────────────────────────────────────────────────────
 *   por dia: cada ordem do RDO procura um lançamento da planilha a até 5 min e 0,5 MW; o que sobra dos dois lados é listado. "bate" quando
 *   nada sobra; "diverge" quando sobra; "so_rdo" quando a planilha não tem o dia; "so_planilha" quando o RDO não tem ordem no dia em que a
 *   planilha tem lançamento (a partir do primeiro dia do RDO). A herdada não entra na comparação (a planilha começa no primeiro lançamento
 *   do turno).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('./lib-ppc.js');

const LOCAL_RDO = process.env.LOCAL_RDO || '';
const LOCAL_PPC = process.env.LOCAL_PPC || '';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const GESTAO_CONTA = process.env.GESTAO_CONTA_URL || 'https://siddgestaodocs.blob.core.windows.net';
const TOL_MIN = 5, TOL_MW = 0.5;

const leJson = (buf) => { let b = buf; if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); return JSON.parse(b.toString('utf8')); };

async function leRdo() {
  if (LOCAL_RDO) return leJson(fs.readFileSync(LOCAL_RDO));
  const c = require('./lib-conteiner').conteinerEm(GESTAO_CONTA, 'indicadores');
  return leJson(await c.getBlobClient('rdo_ordens.json').downloadToBuffer());
}
// 🔴 SÓ O 404 DA PLANILHA vira "sem comparativo"; falha de rede estoura (a lição do leAnterior do gen-ppc)
async function lePlanilha() {
  if (LOCAL_PPC) return leJson(fs.readFileSync(LOCAL_PPC));
  const LD = require('./lib-le-dados');
  const x = await LD.pede(LD.BASE + 'ppc_restricao.json');
  if (x.status === 404) return null;
  if (x.status !== 200) throw new Error('ppc_restricao.json: HTTP ' + x.status);
  return leJson(x.buf);
}

function eventosDoRdo(R) {
  const min = (h) => +String(h).slice(0, 2) * 60 + +String(h).slice(3, 5);
  const ev = [];
  for (const d of (R && R.dias) || []) {
    const lista = [];
    if (d.herdada && Number.isFinite(d.herdada.mw)) lista.push({ min: 0, pot: d.herdada.mw, restr: 1, motivo: d.herdada.motivo || '', motivo_cod: d.herdada.mot || null, herdada: 1, origem: 'rdo', conf: null });
    for (const o of d.ordens || []) {
      const lib = o.tipo === 'lib';
      lista.push({ min: min(o.h), pot: lib ? P.PLENA : o.mw, restr: lib ? 0 : 1, motivo: lib ? 'Fim da restrição' : (o.motivo || ''), motivo_cod: lib ? 'LIVRE' : (o.mot || null),
        origem: o.origem || null, conf: o.conf || null,
        ufvs: o.sp ? Object.fromEntries(Object.entries(o.sp).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, { st: null, sp: v }])) : {} });
    }
    lista.sort((a, b) => a.min - b.min);
    for (const e of lista) ev.push(Object.assign({ dia: d.dia, ts: d.dia + ' ' + P.hhmm(e.min), ms: P.msDe(d.dia, e.min), cenario: '', turno: '', tecnico: '' }, e));
  }
  return ev;
}

function compara(evRdo, evPpc) {
  const porDia = (ev) => { const m = new Map(); for (const e of ev) { const d = e.dia || String(e.ts).slice(0, 10); if (!m.has(d)) m.set(d, []); m.get(d).push(e); } return m; };
  const R = porDia(evRdo.filter((e) => !e.herdada)), Pl = porDia(evPpc || []);
  // 🔴 os dias são a UNIÃO dos dois lados, a partir do primeiro dia do RDO: um dia com lançamento só na planilha (o RDO sem a ordem, ou
  //    sem o dia) é "so_planilha" e quebra a contagem dos 7 dias; percorrendo só os dias do RDO, ele sumia e a contagem passava por cima.
  const ini = [...R.keys()].sort()[0];
  const todos = ini ? [...new Set([...R.keys(), ...[...Pl.keys()].filter((d) => d >= ini)])].sort() : [];
  const out = [];
  for (const dia of todos) {
    const lr = R.get(dia) || [];
    const lp = (Pl.get(dia) || []).slice();
    if (!lr.length) { out.push({ dia, veredito: 'so_planilha', rdo: 0, planilha: lp.length, so_rdo: [], so_planilha: lp.map((e) => String(e.ts).slice(11) + ' ' + e.pot) }); continue; }
    if (!lp.length) { out.push({ dia, veredito: 'so_rdo', rdo: lr.length, planilha: 0, so_rdo: lr.map((e) => e.ts.slice(11) + ' ' + e.pot), so_planilha: [] }); continue; }
    const usados = new Set(), soRdo = [];
    for (const e of lr) {
      let k = -1;
      for (let i = 0; i < lp.length; i++) if (!usados.has(i) && Math.abs(lp[i].min - e.min) <= TOL_MIN && Math.abs(lp[i].pot - e.pot) <= TOL_MW) { k = i; break; }
      if (k < 0) soRdo.push(e.ts.slice(11) + ' ' + e.pot); else usados.add(k);
    }
    const soPl = lp.filter((e, i) => !usados.has(i)).map((e) => String(e.ts).slice(11) + ' ' + e.pot);
    const rr = P.resumoDias(lr)[0], rp = P.resumoDias(lp)[0];
    out.push({ dia, veredito: soRdo.length || soPl.length ? 'diverge' : 'bate', rdo: lr.length, planilha: lp.length,
      horas_rdo: rr.horas_restricao, horas_planilha: rp.horas_restricao, pot_min_rdo: rr.pot_min, pot_min_planilha: rp.pot_min, so_rdo: soRdo, so_planilha: soPl });
  }
  return out;
}

async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (LOCAL_OUT_DIR) { fs.writeFileSync(path.join(LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const c = require('./lib-conteiner').conteiner(OUT_CONTAINER);
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

if (require.main === module) {
  (async () => {
    const R = await leRdo();
    if (!R || !Array.isArray(R.dias)) throw new Error('rdo_ordens.json sem a lista de dias: o contrato do Gestão mudou?');
    const eventos = eventosDoRdo(R), dias = P.resumoDias(eventos);
    const ppc = await lePlanilha();
    const cmp = compara(eventos, ppc && ppc.eventos);
    const seguidos = (() => { let n = 0; for (let i = cmp.length - 1; i >= 0; i--) { if (cmp[i].veredito === 'bate') n++; else break; } return n; })();
    const nA = await grava('ppc_restricao_rdo.json', { fonte: 'RDO do SIGO (aba Restrições do ONS: ordens da coleta e da mesa)',
      grandeza: 'potencia solicitada pelo operador nacional, em MW, no instante em que muda', gerado_em: new Date().toISOString(), plena_mw: P.PLENA,
      rdo_gerado_em: R.gerado_em || null, dias_cobertos: dias.length, eventos, dias, defeitos: [] });
    const nB = await grava('ppc_paralelo.json', { gerado_em: new Date().toISOString(), regra: 'cada ordem do RDO casa com um lancamento da planilha a ate '
      + TOL_MIN + ' min e ' + TOL_MW + ' MW; a herdada fica fora', dias_seguidos_batendo: seguidos, meta_dias: 7, dias: cmp });
    console.log('ppc_restricao_rdo.json: ' + eventos.length + ' eventos · ' + dias.length + ' dias · ' + Math.round(nA / 1024) + ' KB gzipado');
    console.log('ppc_paralelo.json: ' + cmp.map((d) => d.dia + ' ' + d.veredito + (d.veredito === 'diverge' ? ' (só RDO: ' + d.so_rdo.join(', ') + ' · só planilha: ' + d.so_planilha.join(', ') + ')' : '')).join(' | ')
      + ' · ' + seguidos + ' dia(s) seguidos batendo · ' + Math.round(nB / 1024) + ' KB');
  })().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
}

module.exports = { eventosDoRdo, compara };
