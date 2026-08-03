/* repara-ons-mes.js — reconstrói do ONS os meses cujo blob ficou com dias faltando.
 *
 * O DEFEITO QUE ISTO CONSERTA. Os blobs mensais `ons_restricao_YYYY_MM.json` são escritos por um
 * fluxo do Power Automate que só toca no MÊS CORRENTE. O último gravado de cada mês sai às 23:00 UTC
 * do próprio dia 30/31 — e nesse horário o ONS ainda não publicou o dia que está terminando. No dia
 * seguinte o fluxo passa a escrever o mês novo e nunca mais volta ao anterior.
 * Resultado: o ÚLTIMO DIA DE CADA MÊS se perde para sempre.
 *   jun/26 ficou com 29 dias de 30 · jul/26 com 30 de 31 · e 31/08 se perderia igual.
 * Os meses de set/25 a mai/26 estão íntegros só porque foram refeitos num backfill manual em
 * 29/06/2026, quando o ONS já tinha tudo.
 *
 * POR QUE AQUI E NÃO NO FLUXO. O fluxo é a correção certa e continua sendo — mas está fora deste
 * repositório. Enquanto ele não muda, o consolidador (que roda todo dia e já sabe escrever no blob)
 * verifica e repara. Quando o fluxo for corrigido, esta rotina simplesmente não acha nada para fazer.
 *
 * O QUE ELE NÃO FAZ: não toca no mês corrente (o ONS ainda está publicando) nem em mês cujo blob já
 * esteja completo. Reparar é caro — ~9 MB do S3 do ONS por mês — então só age quando falta dia.
 */
const readline = require('readline');
const https = require('https');

const ONS = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/'
  + 'restricao_coff_fotovoltaica_tm/RESTRICAO_COFF_FOTOVOLTAICA';
const ID_ONS = 'CJU_CEMTD';                    // Conjunto Mauriti no arquivo por conjunto
const COLS = { id: 5, ts: 7, ger: 8, lim: 9, disp: 10, gref: 11, razao: 13, orig: 14, dsc: 15 };

const diasNoMes = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();

/** Baixa o mês do ONS e devolve as linhas do conjunto, no formato do blob. */
function baixarMes(ym) {
  const arq = ONS + '_' + ym.replace('-', '_') + '.csv';
  return new Promise((res, rej) => {
    https.get(arq, { timeout: 300000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const out = [];
      const rl = readline.createInterface({ input: r, crlfDelay: Infinity });
      rl.on('line', l => {
        if (!l || l.indexOf(ID_ONS) < 0) return;             // filtro barato antes do split
        const c = l.split(';');
        if (c[COLS.id] !== ID_ONS) return;
        const n = i => { const v = String(c[i] ?? '').trim().replace(',', '.'); return v === '' ? null : +v; };
        out.push({ ts: String(c[COLS.ts]).trim(), ger: n(COLS.ger), lim: n(COLS.lim),
          disp: n(COLS.disp), gref: n(COLS.gref),
          razao: String(c[COLS.razao] ?? '').trim(), orig: String(c[COLS.orig] ?? '').trim(),
          dsc: String(c[COLS.dsc] ?? '').trim() });
      });
      rl.on('close', () => res(out));
      rl.on('error', rej);
    }).on('error', rej);
  });
}

/**
 * @param {(u:string)=>Promise<any>} fetchJson  leitor de blob do consolidador
 * @param {(nome:string,json:string)=>Promise<void>} upload  gravador de blob do consolidador
 * @param {string} BASE  url pública do container
 * @param {string[]} meses  lista YYYY_MM que o consolidador já monta
 */
async function repararMeses(fetchJson, upload, BASE, meses) {
  const agora = new Date();
  const mesCorrente = agora.getUTCFullYear() + '_' + String(agora.getUTCMonth() + 1).padStart(2, '0');
  const reparados = [];
  for (const ym of meses) {
    if (ym === mesCorrente) continue;                        // o ONS ainda está publicando
    const alvo = 'ons_restricao_' + ym + '.json';
    const d = await fetchJson(BASE + alvo);
    if (!d || !Array.isArray(d.consolidado)) continue;
    const iso = ym.replace('_', '-');
    const tem = new Set(d.consolidado.map(r => String(r.ts || '').slice(0, 10)));
    const esperado = diasNoMes(iso);
    const faltam = [];
    for (let i = 1; i <= esperado; i++) {
      const dia = iso + '-' + String(i).padStart(2, '0');
      if (!tem.has(dia)) faltam.push(dia);
    }
    if (!faltam.length) continue;
    console.log('  ' + ym + ': faltam ' + faltam.length + ' dia(s) — ' + faltam.map(x => x.slice(-2)).join(',')
      + ' · rebaixando do ONS');
    let linhas;
    try { linhas = await baixarMes(iso); }
    catch (e) { console.warn('  ' + ym + ': ONS indisponível (' + e.message + ') — mantido como está'); continue; }
    const diasNovo = new Set(linhas.map(r => r.ts.slice(0, 10)));
    // NUNCA piorar: se o ONS ainda não tem os dias que faltam, o blob antigo fica.
    if (linhas.length <= d.consolidado.length || faltam.some(x => !diasNovo.has(x))) {
      console.warn('  ' + ym + ': o ONS ainda não publicou tudo (' + diasNovo.size + ' dias) — mantido');
      continue;
    }
    const obj = Object.assign({}, d, {
      atualizado: new Date().toISOString(),
      reparado_em: new Date().toISOString(),
      reparo_nota: 'Reconstruído do arquivo do ONS: o blob anterior tinha ' + tem.size + ' de '
        + esperado + ' dias. O fluxo que grava este arquivo só escreve o mês corrente e para no dia '
        + esperado + ' às 23:00 UTC, antes de o ONS publicar o último dia.',
      consolidado: linhas,
    });
    await upload(alvo, JSON.stringify(obj));
    console.log('  ' + ym + ': reparado — ' + tem.size + ' -> ' + diasNovo.size + ' dias, '
      + d.consolidado.length + ' -> ' + linhas.length + ' linhas');
    reparados.push(ym);
  }
  if (!reparados.length) console.log('  nenhum mês precisou de reparo');
  return reparados;
}

module.exports = { repararMeses };
