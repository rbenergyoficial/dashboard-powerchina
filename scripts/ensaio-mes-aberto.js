/*
 * ensaio-mes-aberto.js — a serie mensal e a manchete dizem a MESMA coisa sobre o mes estar aberto (PROMOVER mes-aberto).
 *
 * POR QUE EXISTE. Em 30/09/2026 — o ultimo dia do mes, de manha — o `serie_ufv` publicou set/26 com `parcial: 0` enquanto
 * a manchete dizia `fechado: 0` e 1 dia restante. O `parcial` saia de "a meta ainda precisa ser rateada", e no ultimo dia,
 * com todos os dias ja medidos, o fator do rateio vira 1. O portal leu "mes fechado": perdeu a regua da capa, o "% do mes"
 * do Entregue e abriu no ano. Dois relogios no mesmo blob, e nenhum ensaio olhava os dois juntos.
 *
 * O QUE PROVA. No blob publicado, para o mes atual: em cada entidade da manchete, `serie_ufv.parcial` e 1 exatamente
 * quando a manchete diz `fechado: 0`; e a linha do conjunto em `serie` (e em `serie_e_media`, se houver) acompanha a do
 * Complexo. PLANTIO: o mesmo blob com o `parcial` do Complexo trocado reprova.
 * Roda depois de gerar. Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome)));
    req.on('error', ko);
  });
}

function julga(j) {
  const f = [], mes = j.mes_atual;
  const M = (j.manchete_ufv || []).filter((m) => m.mes === mes);
  if (!M.length) return { f: [], n: 0, nota: 'a manchete nao tem linha do mes ' + mes + ' — nada a julgar' };
  let n = 0;
  M.forEach((m) => {
    const s = (j.serie_ufv || []).find((x) => x.mes === mes && x.ufv === m.ufv);
    if (!s) return;
    n += 1;
    const esp = m.fechado === 0 ? 1 : 0;
    if (s.parcial !== esp) f.push(m.ufv + ' ' + mes + ': serie_ufv.parcial ' + s.parcial + ', a manchete diz fechado ' + m.fechado);
  });
  const mc = M.find((m) => m.ufv === 'Complexo');
  if (mc) {
    const esp = mc.fechado === 0 ? 1 : 0;
    for (const k of ['serie', 'serie_e_media']) {
      const x = (j[k] || []).find((r) => r.mes === mes);
      if (x && x.parcial !== esp) f.push(k + ' ' + mes + ': parcial ' + x.parcial + ', a manchete do Complexo diz fechado ' + mc.fechado);
    }
  }
  if (!n) f.push('nenhuma entidade da manchete tem linha no serie_ufv de ' + mes + ' — o ensaio passaria sobre nada');
  return { f, n };
}

(async () => {
  const j = await getJSON('executivo.json');
  const r = julga(j);
  if (r.nota) { console.log('   ' + r.nota); console.log('ensaio-mes-aberto: TUDO PASSOU (nada a julgar)'); return; }
  const mc = (j.manchete_ufv || []).find((m) => m.ufv === 'Complexo' && m.mes === j.mes_atual);
  console.log('   ' + j.mes_atual + ': ' + r.n + ' entidades julgadas · manchete do Complexo fechado=' + (mc ? mc.fechado : '—'));
  // PLANTIO: o parcial do Complexo trocado tem de reprovar
  const p = JSON.parse(JSON.stringify(j));
  const s = (p.serie_ufv || []).find((x) => x.mes === p.mes_atual && x.ufv === 'Complexo');
  if (s) s.parcial = s.parcial === 1 ? 0 : 1;
  const rp = julga(p);
  console.log('   plantio (parcial do Complexo trocado): ' + rp.f.length + ' achado(s)');
  const f = r.f.slice();
  if (!s || !rp.f.length) f.push('o plantio do parcial trocado NAO reprova — o ensaio nao mede nada');
  if (f.length) { f.forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-mes-aberto: TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
