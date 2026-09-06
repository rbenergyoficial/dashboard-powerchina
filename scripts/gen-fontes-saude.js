// gen-fontes-saude.js — o selo de frescor de cada pagina passa a medir a FONTE DA PROPRIA PAGINA.
//
// 🔴 POR QUE EXISTE (Lote B da auditoria de 06/09/2026, portao C10)
// O selo [112] do cabecalho lia `way2_saude.json` em SEIS paginas cujo dado nao e da Way2, e
// anunciava "11 min · MEDIDORES 24/24" sobre:
//   · quatro paginas de transformadores, cujo ultimo dia medido tinha 2,7 dias de atraso;
//   · a de oleo isolante, cuja ultima coleta tinha 75 dias;
//   · a do ONS, onde o painel nem consulta tinha e renderizava vazio.
// "Fresco" sobre dado velho e o modo de falhar mais caro desta casa: nada fica vermelho, e o
// leitor confia.
//
// O QUE ELE PUBLICA: `fontes_saude.json`, um blob leve com uma lista de `badges` POR FONTE, no
// MESMO formato que o selo ja renderiza ({ic, l, v, u, c}) — a edicao nos dashboards e so trocar
// a URL e o `root_selector`. A regra de cor mora aqui, uma vez, por fonte.
//
// 🔴 LIMIARES COM FONTE NOMEADA — a cadencia de cada fonte, do proprio pipeline (pipeline.md):
//   trafo   `trafo.yml` roda 1x/dia (10:38 UTC) sobre despejo diario  -> verde ate 36 h, ambar ate 72 h
//   oleo    coleta TRIMESTRAL, blob gravado por push (sem cron)       -> verde ate 120 d, ambar ate 180 d
//   ons     publicacao D+1 (consolidado 18:17 UTC)                     -> verde ate 36 h, ambar ate 60 h
//   O que se mede e a idade do ULTIMO DADO (dia/coleta/instante), nao a do blob: um gerador que
//   republica o mesmo dado velho todo dia manteria o blob fresco e a informacao velha.
//
// ⚠️ Se uma fonte nao puder ser lida, o selo dela sai VERMELHO com "sem leitura" — nunca some,
//    nunca herda a cor de outra fonte. Ausencia declarada e informacao; selo vazio e ruido.
'use strict';
const https = require('https');
const zlib = require('zlib');
const rot = require('./lib-rotulos.js');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_BLOB = 'fontes_saude.json';
const AGORA = Date.now();
const VERDE = '#2FBF71', AMBAR = '#FF8A3D', VERMELHO = '#E5484D';   // as mesmas do selo da Way2

function le(nome) {
  return new Promise((res, rej) => {
    https.get(BASE + nome, { family: 4, headers: { 'accept-encoding': 'gzip' } }, (r) => {
      if (r.statusCode !== 200) return rej(new Error(nome + ' HTTP ' + r.statusCode));
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { let b = Buffer.concat(c); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); res(JSON.parse(b.toString('utf8'))); });
    }).on('error', rej);
  });
}
const horas = (ms) => (AGORA - ms) / 3600000;
const dias = (ms) => horas(ms) / 24;
const cor = (v, verde, ambar) => v <= verde ? VERDE : v <= ambar ? AMBAR : VERMELHO;
const ddmm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

// cada fonte devolve os seus badges; erro vira badge vermelho, nunca excecao que derrube o job
async function trafo() {
  try {
    const t = await le('trafo_diario.json');
    // a serie diaria e a lista cujo ultimo item tem `dia` — o nome da raiz nao e contrato
    // (`trafos` e o cadastro dos dois equipamentos; a serie vive em `dias`)
    const s = ['dias', 'serie', 'diario'].map((k) => t[k]).find((a) => Array.isArray(a) && a.length && a[a.length - 1].dia) || [];
    const ult = s.length ? s[s.length - 1] : null;
    if (!ult || !ult.dia) throw new Error('sem dia');
    const fim = Date.parse(ult.dia + 'T23:59:59-03:00');          // o dia inteiro medido
    const h = horas(fim);
    return [
      { ic: '⚡', l: 'Supervisório', v: ddmm(ult.dia), u: 'último dia', c: cor(h, 36, 72) },
      { ic: '⏱', l: 'Idade', v: String(Math.round(h)), u: 'h', c: cor(h, 36, 72) },
    ];
  } catch (e) { return [{ ic: '⚡', l: 'Supervisório', v: 'sem leitura', u: '', c: VERMELHO }]; }
}
async function oleo() {
  try {
    const o = await le('oleo.json');
    const cm = (o.campanhas_meta || []);
    const ult = cm.length ? cm[cm.length - 1] : null;
    if (!ult || !ult.ultima) throw new Error('sem campanha');
    const d = dias(Date.parse(ult.ultima + 'T12:00:00-03:00'));
    return [
      { ic: '🧪', l: 'Última coleta', v: ddmm(ult.ultima), u: ult.camp_rot || '', c: cor(d, 120, 180) },
      { ic: '⏱', l: 'Idade', v: String(Math.round(d)), u: 'dias', c: cor(d, 120, 180) },
    ];
  } catch (e) { return [{ ic: '🧪', l: 'Última coleta', v: 'sem leitura', u: '', c: VERMELHO }]; }
}
async function ons() {
  try {
    const r = await le('ons_restricao_all.json');
    const L = r.consolidado || [];
    const ult = L.length ? L[L.length - 1].ts : null;                 // 'AAAA-MM-DD HH:MM:SS' local
    if (!ult) throw new Error('sem instante');
    const h = horas(Date.parse(ult.replace(' ', 'T') + '-03:00'));
    return [
      { ic: '🛰', l: 'ONS', v: ddmm(ult) + ' ' + ult.slice(11, 16), u: 'último instante', c: cor(h, 36, 60) },
      { ic: '⏱', l: 'Idade', v: String(Math.round(h)), u: 'h', c: cor(h, 36, 60) },
    ];
  } catch (e) { return [{ ic: '🛰', l: 'ONS', v: 'sem leitura', u: '', c: VERMELHO }]; }
}
// a Way2 continua sendo a Way2: copia dos badges que o selo original ja usa, para quem quiser
// UM arquivo so — e para o ensaio comparar o formato
async function way2() {
  try { const s = await le('way2_saude.json'); return s.badges || []; }
  catch (e) { return [{ ic: '⏱', l: 'Way2', v: 'sem leitura', u: '', c: VERMELHO }]; }
}

(async () => {
  const [bt, bo, bn, bw] = await Promise.all([trafo(), oleo(), ons(), way2()]);
  // os rotulos nas tres linguas, como o selo original — a barra esta em paginas traduzidas
  [bt, bo, bn].forEach((lista) => lista.forEach((b) => rot.localiza(b, ['l', 'u'])));
  const out = {
    gerado_em: new Date(AGORA).toISOString(),
    nota: 'Selos de frescor por FONTE. Cada lista mede a idade do ultimo DADO da fonte (dia, coleta ou instante), '
      + 'nao a do arquivo. Limiares pela cadencia de cada fonte: supervisorio diario (36/72 h), oleo trimestral '
      + '(120/180 dias), ONS D+1 (36/60 h).',
    badges_trafo: bt, badges_oleo: bo, badges_ons: bn, badges_way2: bw,
  };
  const json = JSON.stringify(out);
  const resumo = (l) => l.map((b) => b.l + ' ' + b.v + (b.u ? ' ' + b.u : '') + ' ' + b.c).join(' · ');
  console.log('trafo: ' + resumo(bt)); console.log('oleo : ' + resumo(bo)); console.log('ons  : ' + resumo(bn));
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); console.log('local: ' + process.env.LOCAL_OUT + ' · ' + json.length + ' bytes'); return; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(process.env.OUT_CONTAINER || 'dados');
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=120' } });
  console.log(OUT_BLOB + ' OK · ' + json.length + ' bytes');
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
