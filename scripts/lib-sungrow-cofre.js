'use strict';
/*
 * lib-sungrow-cofre.js — os zips do logger Sungrow lidos do COFRE (`backup-dados-scada`), com o nome do `sungrow-raw`
 * (20/10/2026, lote pa-sungrow). Decide sem rede; quem lista e baixa e o gen-sungrow.js.
 *
 * O fluxo pago do Power Automate ("Sungrow OneDrive RB para Blob") copia cada zip da pasta `Sungrow_dados` para o
 * `sungrow-raw` com o caminho relativo a ela (`M05/TS01/01 A 05/27.09 A 30.09.zip`): esse nome e o contrato do gerador (o
 * manifesto `sg_lidos.json` guarda nome + tamanho). Desde 18/10/2026 a maquina-ponte grava os MESMOS zips no cofre, em
 * `Sungrow_Logger/Sungrow_dados/<ano>/<usina>/<TS>/<grupo>/<dd.MM A dd.MM>.zip`; nome repetido com outro tamanho sobe ao lado,
 * como `<nome>~AAAAMMDD-HHMMSS` (a data do arquivo). Esta lib tira o prefixo `Sungrow_Logger/Sungrow_dados/<ano>/`.
 *
 * Regras (cada uma reprovada por um plantio no ensaio-sungrow-cofre.js):
 *   · o nome mapeado tem a forma do contrato do sungrow-raw (`M<NN>/TS<NN>/<grupo>/<arquivo>.zip`); zip dentro da arvore das
 *     usinas fora dessa forma, pasta de usina fora de `M<NN>` (`M1/...`) ou sufixo de versao ilegivel e RECUSADO e acusado,
 *     nunca lido nem calado;
 *   · fora da arvore das usinas (o despejo de depuracao do logger, `EM ANALESE_log_log/...`) e dentro dela o que nao e zip
 *     (`A23C0400548.xlsx`) fica IGNORADO e contado: o fluxo so copiava zip de `Sungrow_dados/M...`;
 *   · a versao: o nome sem sufixo e a PRIMEIRA copia; vale a de maior carimbo `~AAAAMMDD-HHMMSS`, nunca a ordem da listagem;
 *   · o mesmo nome mapeado em dois anos (o `sungrow-raw` nao tem o ano no nome: `05.10 A 05.10.zip` de 2026 e de 2027) e
 *     RECUSADO nos dois: o manifesto por nome + tamanho confundiria os dois arquivos;
 *   · a comparacao (sombra) e por LOTE (o nome do zip, `19.10 A 19.10.zip`: o dia da coleta automatica): lote que o
 *     sungrow-raw tem e o cofre nao e FALHA (dia faltando no cofre); lote so no cofre e nomeado (o fluxo nao entregou); no
 *     lote dos dois, o conjunto de nomes tem de ser igual e cada par do mesmo tamanho. Lote com gravacao mais nova que
 *     `vivoMin` nao e julgado (o fluxo copia minutos depois da ponte).
 */

const COFRE = 'backup-dados-scada';
const PREFIXO = 'Sungrow_Logger/Sungrow_dados/';
// o contrato do sungrow-raw: o mesmo filtro do listaRaw do gen-sungrow
const NOME_RAW = /^M\d\d\/TS\d\d\/[^/]+\/[^/]+\.zip$/i;
const ANO = /^(\d{4})\/(.+)$/;
const VERSAO = /^(.+)~(\d{8}-\d{6})$/;

const lote = (nome) => nome.split('/').pop();
const ms = (d) => (d instanceof Date ? d.getTime() : Date.parse(d));

/**
 * lista: [{ name, size, md5, lastModified }] — a listagem do cofre com o prefixo PREFIXO
 * -> { zips: Map(nomeRaw -> { fonte, bytes, md5, lastModified, ano, versao, anteriores:[{ fonte, versao, bytes }] }),
 *      ignorados: { chave: n }, recusados: [{ nome, motivo }], lidos: n }
 */
function mapeia(lista, prefixo) {
  const pre = prefixo == null ? PREFIXO : prefixo;
  const ignorados = {}, recusados = [];
  const ign = (k) => { ignorados[k] = (ignorados[k] || 0) + 1; };
  const porNome = new Map();
  for (const b of lista) {
    if (!b.name.startsWith(pre)) { recusados.push({ nome: b.name, motivo: 'fora do prefixo ' + pre }); continue; }
    const rel = b.name.slice(pre.length);
    const a = ANO.exec(rel);
    if (!a) { if (/\.zip(~|$)/i.test(rel)) recusados.push({ nome: b.name, motivo: 'zip fora da pasta do ano' }); else ign('(sem ano)'); continue; }
    const [, ano, resto] = a;
    const topo = resto.split('/')[0];
    if (!/^M\d+$/i.test(topo)) { ign(ano + '/' + topo); continue; }                 // fora da arvore das usinas
    if (!/^M\d\d$/.test(topo)) { recusados.push({ nome: b.name, motivo: 'pasta de usina fora da forma M<NN>: ' + topo }); continue; }
    const base = resto.split('/').pop();
    let nome = resto, versao = '';
    if (base.includes('~')) {
      const v = VERSAO.exec(resto);
      if (!v) { recusados.push({ nome: b.name, motivo: 'sufixo de versao ilegivel (esperado ~AAAAMMDD-HHMMSS)' }); continue; }
      nome = v[1]; versao = v[2];
    }
    if (!/\.zip$/i.test(nome)) { ign(ano + '/' + topo + ' (nao zip)'); continue; }
    if (!NOME_RAW.test(nome)) { recusados.push({ nome: b.name, motivo: 'zip fora da forma M<NN>/TS<NN>/<grupo>/<arquivo>.zip' }); continue; }
    const l = porNome.get(nome) || [];
    l.push({ fonte: b.name, bytes: b.size, md5: b.md5 || null, lastModified: b.lastModified, ano, versao });
    porNome.set(nome, l);
  }
  const zips = new Map();
  for (const [nome, vs] of porNome) {
    const anos = [...new Set(vs.map((x) => x.ano))].sort();
    if (anos.length > 1) {
      for (const x of vs) recusados.push({ nome: x.fonte, motivo: 'o mesmo nome mapeado em ' + anos.join(' e ') + ' (o sungrow-raw nao tem o ano no nome)' });
      continue;
    }
    // a versao mais nova pelo carimbo; o nome sem sufixo ('') e a primeira copia
    const maior = vs.reduce((m, x) => (x.versao > m.versao ? x : m));
    zips.set(nome, Object.assign({}, maior, { anteriores: vs.filter((x) => x !== maior).map((x) => ({ fonte: x.fonte, versao: x.versao, bytes: x.bytes })) }));
  }
  return { zips, ignorados, recusados, lidos: lista.length };
}

/**
 * a sombra: o cofre mapeado contra a listagem do sungrow-raw, lote a lote.
 * mapa: o retorno de mapeia · raw: [{ name, size, md5, lastModified }] · op: { agora (ms), vivoMin }
 * -> { lotes: { julgados, vivos, so_cofre, so_raw }, nomes_iguais, falhas: [texto], nomeadas: [texto], pares: [[fonte, nomeRaw, bytes]] }
 */
function compara(mapa, raw, op) {
  const agora = (op && op.agora) || Date.now();
  const vivoMs = ((op && op.vivoMin != null) ? op.vivoMin : 120) * 60e3;
  const falhas = [], nomeadas = [], pares = [];
  const r = new Map();
  let rawFora = 0;
  for (const b of raw) { if (NOME_RAW.test(b.name)) r.set(b.name, b); else rawFora++; }
  if (rawFora) nomeadas.push(rawFora + ' blob(s) do sungrow-raw fora da forma do contrato (o gerador nao os le)');
  const porLote = new Map();
  const poe = (nome, lado, x) => { const k = lote(nome); const o = porLote.get(k) || { raw: new Map(), cofre: new Map() }; o[lado].set(nome, x); porLote.set(k, o); };
  for (const [n, b] of r) poe(n, 'raw', b);
  for (const [n, z] of mapa.zips) poe(n, 'cofre', z);
  const L = { julgados: 0, vivos: 0, so_cofre: 0, so_raw: 0 };
  let iguais = 0;
  for (const [k, o] of [...porLote].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const novo = Math.max(...[...o.raw.values(), ...o.cofre.values()].map((x) => ms(x.lastModified)));
    if (agora - novo < vivoMs) { L.vivos++; nomeadas.push('lote "' + k + '" vivo (gravado ha menos de ' + vivoMs / 60e3 + ' min): nao julgado'); continue; }
    if (!o.cofre.size) { L.so_raw++; falhas.push('lote "' + k + '": ' + o.raw.size + ' zip(s) no sungrow-raw e nenhum no cofre (dia faltando no cofre)'); continue; }
    if (!o.raw.size) { L.so_cofre++; nomeadas.push('lote "' + k + '": ' + o.cofre.size + ' zip(s) so no cofre (o fluxo nao entregou)'); continue; }
    L.julgados++;
    for (const [n, b] of o.raw) {
      const z = o.cofre.get(n);
      if (!z) { falhas.push('lote "' + k + '": ' + n + ' no sungrow-raw e nao no cofre'); continue; }
      if (z.bytes === b.size) {
        if (z.md5 && b.md5 && z.md5 !== b.md5) { falhas.push(n + ': mesmo tamanho, MD5 diferente'); continue; }
        iguais++; pares.push([z.fonte, n, b.size, ms(b.lastModified)]); continue;
      }
      if (z.anteriores.some((x) => x.bytes === b.size)) {
        nomeadas.push(n + ': o sungrow-raw ficou com a versao anterior (' + b.size + ' B); o cofre traz ' + z.fonte.split('/').pop() + ' (' + z.bytes + ' B)');
        continue;
      }
      falhas.push(n + ': ' + b.size + ' B no sungrow-raw e ' + z.bytes + ' B no cofre (' + z.fonte + ')');
    }
    for (const n of o.cofre.keys()) if (!o.raw.has(n)) falhas.push('lote "' + k + '": ' + n + ' no cofre e nao no sungrow-raw');
  }
  return { lotes: L, nomes_iguais: iguais, falhas, nomeadas, pares };
}

/**
 * a lista que o gerador le no modo `uniao`: o historico do sungrow-raw mais o cofre; no nome que os dois tem, vale o cofre
 * (a versao mais nova). raw: [{ nome, bytes, ler }] · deCofre: [{ nome, bytes, ler }]
 */
function uniao(raw, deCofre) {
  const m = new Map(raw.map((z) => [z.nome, Object.assign({ origem: 'raw' }, z)]));
  for (const z of deCofre) m.set(z.nome, Object.assign({ origem: 'cofre' }, z));
  return [...m.values()];
}

module.exports = { COFRE, PREFIXO, NOME_RAW, mapeia, compara, uniao, lote };
