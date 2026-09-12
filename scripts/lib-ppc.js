/*
 * lib-ppc.js — o registro do PPC: leitura, normalizacao e integralizacao na janela do ONS.
 *
 * A mesa de operacao anota, numa planilha, a POTENCIA SOLICITADA pelo operador nacional no
 * minuto em que ela muda. Este arquivo transforma esse registro de EVENTO em algo comparavel
 * com o que o ONS publica, e e a UNICA escrita dessa logica — o gerador, a auditoria e o ensaio
 * leem daqui. Duas escritas do mesmo trecho ja divergiram tres vezes numa sessao nesta casa.
 *
 * ── AS TRES COISAS QUE FORAM MEDIDAS ANTES DE ESCREVER, e que decidem o codigo ───────────────
 *
 * 🔴 1 · O VALOR E LIDO CRU (serial do Excel), NUNCA COMO Date.
 *    A coluna de data tem QUATRO formas no mesmo arquivo: serial numerico (1.921 linhas), texto
 *    `dd/mm/aaaa` (29), vazia (114) e texto com ano impossivel. A de hora tem tres. Converter
 *    para Date passa pelo fuso, e o epoch de 1899 no Brasil carrega o offset LMT de -03:06:28 —
 *    a hora 07:00 chega como `1899-12-30T10:06:28Z`. Com o serial, dia e hora saem por
 *    aritmetica pura e o fuso nunca entra. E a mesma familia da armadilha do Parquet do ONS.
 *
 * 🔴 2 · A RESTRICAO E DECIDIDA PELO NUMERO, NUNCA PELO TEXTO DO MOTIVO.
 *    Medido em setembro/2026: 12 linhas trazem "Sem restricoes" com potencia de 315 a 338 MW, e
 *    2 trazem "Motivo: Energetico" em linha de potencia plena. O texto contradiz o numero. Um
 *    classificador que lesse o motivo concluiria "sem corte" numa hora restrita. O motivo vai
 *    junto como texto descritivo e como codigo, mas quem decide se houve restricao e
 *    `pot < PLENA`. A razao com valor de verdade e o `razao` do ONS (ENE/REL/CNF).
 *
 * 🔴 3 · EVENTO E MEIA HORA SAO RESOLUCOES DIFERENTES.
 *    A planilha e um degrau: o setpoint vale do minuto em que foi anotado ate o proximo evento
 *    do MESMO dia. O ONS publica a meia hora integralizada, rotulada pela BORDA ESQUERDA.
 *    Comparar ponto a ponto daria divergencia em quase toda linha, e ela seria de RESOLUCAO.
 *    Por isso `integraliza()` faz a media do degrau ponderada pelo TEMPO dentro do slot — e
 *    devolve a COBERTURA junto: slot coberto por 1 de 30 minutos nao se compara com a integral
 *    de meia hora, e chamar isso de divergencia seria repetir a armadilha da janela do agregado.
 *
 * ⚠️ O dia corrente esta SEMPRE sendo digitado — a planilha e preenchida ao longo do turno, e a
 *    ultima linha costuma estar sem cenario e sem motivo. Isso nao e defeito; quem consome tem de
 *    tolerar, e a rodada nova tem de GANHAR na colisao.
 */
'use strict';

const PLENA = 343.77;              // o complexo sem restricao, em MW (soma das nove outorgas)
const FOLGA = 0.01;                // abaixo de PLENA - FOLGA e restricao
const LINHA0 = 6;                  // a primeira linha de dado; 0..5 sao titulo, legenda e cabecalho

// as colunas, pela posicao no cabecalho medido em 12/09/2026
const COL = { data: 0, hora: 1, turno: 2, tecnico: 3, pot: 4, disp: 5, cenario: 6, limite: 7, motivo: 26, obs: 27 };
// os pares status/setpoint por usina, na ordem em que a planilha os escreve
const COL_UFV = [['M2', 8, 9], ['M3', 10, 11], ['M4', 12, 13], ['M5', 14, 15], ['M6', 16, 17],
  ['M8', 18, 19], ['M7', 20, 21], ['M9', 22, 23], ['M10', 24, 25]];

/* serial do Excel -> AAAA-MM-DD, por aritmetica (epoch 1899-12-30), sem tocar em fuso */
const serialParaDia = (n) => new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
/* fracao do dia -> minutos desde a meia-noite */
const fracaoParaMin = (n) => Math.round((n - Math.floor(n)) * 1440);
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
/* o instante em epoch, pelo fuso de Brasilia declarado — nunca pelo relogio da maquina que roda */
const msDe = (dia, min) => Date.parse(dia + 'T' + hhmm(min) + ':00-03:00');

/*
 * O motivo vira CODIGO. Medidas 34 grafias distintas para o mesmo punhado de causas — variam em
 * caixa, acento e redacao ("Motivo: Energetico (Controle de Frequencia)", "motivo:...",
 * "Motivo enegetico..."). O texto original continua publicado ao lado; o codigo e o que se agrega.
 * ⚠️ A ordem IMPORTA: uma linha pode citar mais de uma causa, e a primeira que casa vence.
 */
const REGRAS_MOTIVO = [
  [/inequa|sgi|conting|indisponib|elétric|eletric/i, 'ELE_SGI'],
  [/fluxo|fnese|intercâmb|intercamb/i, 'FLUXO'],
  [/reativ/i, 'REATIVO'],
  [/patamar/i, 'PATAMAR'],
  [/ppa/i, 'PPA'],
  [/energ|frequ/i, 'ENE_FREQ'],
  [/fim da restri|sem restri/i, 'LIVRE'],
];
function codigoMotivo(txt) {
  const s = String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (const [re, cod] of REGRAS_MOTIVO) if (re.test(s)) return cod;
  return 'OUTRO';
}

/**
 * Le a planilha e devolve os eventos, ja ordenados, mais a lista de defeitos encontrados.
 * @param {object} XLSX  a biblioteca, injetada por quem chama (a lib nao escolhe dependencia)
 * @param {Buffer|string} fonte  o conteudo do xlsx (Buffer) ou o caminho dele
 */
function leEventos(XLSX, fonte) {
  const wb = Buffer.isBuffer(fonte)
    ? XLSX.read(fonte, { type: 'buffer', cellDates: false })
    : XLSX.readFile(fonte, { cellDates: false });        // CRU: serial, nunca Date
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('a planilha nao tem aba nenhuma');
  const L = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const ev = [];
  const def = [];      // { linha, tipo, valor } — um defeito por ocorrencia, com a linha
  let vazias = 0;
  const marca = (linha, tipo, valor) => def.push({ linha, tipo, valor: String(valor == null ? '' : valor).slice(0, 60) });

  for (let i = LINHA0; i < L.length; i++) {
    const r = L[i] || [];
    const ln = i + 1;                                     // a linha como o humano a ve no Excel
    const cd = r[COL.data], ch = r[COL.hora];
    if ((cd == null || String(cd).trim() === '') && (ch == null || String(ch).trim() === '')) { vazias += 1; continue; }

    let dia = null;
    if (typeof cd === 'number' && isFinite(cd)) dia = serialParaDia(cd);
    else if (typeof cd === 'string') {
      const m = cd.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,6})$/);
      if (m) {
        const a = Number(m[3]);
        // o ano fora da faixa e o defeito que ja custou 18 linhas invisiveis (`11/09/20206`)
        if (a < 2020 || a > 2100) marca(ln, 'ano_impossivel', cd.trim());
        else dia = String(a) + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      }
    }
    if (!dia) { marca(ln, 'data_ilegivel', cd); continue; }

    let min = null;
    if (typeof ch === 'number' && isFinite(ch)) min = fracaoParaMin(ch);
    else if (typeof ch === 'string') {
      const m = ch.trim().match(/^(\d{1,2}):(\d{2})/);
      if (m) min = Number(m[1]) * 60 + Number(m[2]);
    }
    if (min == null || min < 0 || min > 1439) { marca(ln, 'hora_ilegivel', ch); continue; }

    const cp = r[COL.pot];
    let pot = null;
    if (typeof cp === 'number' && isFinite(cp)) pot = cp;
    else if (typeof cp === 'string' && cp.trim() !== '') {
      const v = Number(cp.trim().replace(',', '.'));
      // numero gravado como texto nao agrega em planilha nenhuma; aqui e so formato, o valor presta
      if (isFinite(v)) { pot = v; marca(ln, 'pot_texto', cp.trim()); }
    }
    if (pot == null) { marca(ln, 'pot_ilegivel', cp); continue; }
    // uma HORA digitada na coluna de potencia vira um numero entre 0 e 1; acima da plena e digitacao
    if (pot < 0 || pot > PLENA + FOLGA) marca(ln, 'pot_fora_de_faixa', pot);

    const motivo = String(r[COL.motivo] == null ? '' : r[COL.motivo]).replace(/\s+/g, ' ').trim();
    const restr = pot < PLENA - FOLGA;
    const cod = codigoMotivo(motivo);
    // o texto contradiz o numero — nao invalida a linha, mas tem de ser visivel
    if (restr && cod === 'LIVRE') marca(ln, 'motivo_nega_restricao', motivo);
    if (!restr && cod && cod !== 'LIVRE') marca(ln, 'motivo_de_restricao_em_linha_livre', motivo);

    const ufvs = {};
    for (const [nome, cs, cv] of COL_UFV) {
      const st = String(r[cs] == null ? '' : r[cs]).trim();
      const sp = typeof r[cv] === 'number' && isFinite(r[cv]) ? r[cv] : null;
      if (st || sp != null) ufvs[nome] = { st: st || null, sp };
    }

    ev.push({ dia, min, ts: dia + ' ' + hhmm(min), ms: msDe(dia, min), pot,
      restr: restr ? 1 : 0, motivo, motivo_cod: cod,
      cenario: String(r[COL.cenario] == null ? '' : r[COL.cenario]).replace(/\s+/g, ' ').trim(),
      turno: String(r[COL.turno] == null ? '' : r[COL.turno]).trim(),
      tecnico: String(r[COL.tecnico] == null ? '' : r[COL.tecnico]).trim(),
      ufvs, linha: ln });
  }

  // ordem e duplicidade se medem ANTES de ordenar: a ordem do arquivo e informacao, e foi ela
  // que denunciou uma liberacao gravada no meio do dia (11/09, "13:43" no lugar de 15:43)
  for (let i = 1; i < ev.length; i++) {
    const a = ev[i - 1], b = ev[i];
    if (b.dia < a.dia || (b.dia === a.dia && b.min < a.min)) marca(b.linha, 'fora_de_ordem', b.ts);
    if (b.dia === a.dia && b.min === a.min) marca(b.linha, 'carimbo_duplicado', b.ts);
  }
  ev.sort((a, b) => (a.ms - b.ms) || (a.linha - b.linha));
  return { ev, def, vazias };
}

/**
 * Integraliza o degrau da planilha na meia hora do ONS, DENTRO do dia.
 * Devolve um Map "AAAA-MM-DD HH:MM" -> { pot, cobertura, motivos, cods }.
 * ⚠️ Fora do primeiro e do ultimo evento do dia NAO HA registro — e ausencia nao e "sem
 *    restricao". Chamar de livre o que nao foi registrado inverteria o sinal do achado.
 */
function integraliza(ev) {
  const porDia = new Map();
  for (const e of ev) { if (!porDia.has(e.dia)) porDia.set(e.dia, []); porDia.get(e.dia).push(e); }
  const slots = new Map();
  for (const [dia, lista] of porDia) {
    const ini = lista[0].min, fim = lista[lista.length - 1].min;
    let k = 0;
    for (let s = Math.floor(ini / 30) * 30; s <= fim; s += 30) {
      let soma = 0, peso = 0;
      const motivos = new Set(), cods = new Set();
      for (let m = Math.max(s, ini); m < s + 30 && m <= fim; m++) {
        while (k + 1 < lista.length && lista[k + 1].min <= m) k += 1;
        while (k > 0 && lista[k].min > m) k -= 1;
        if (lista[k].min > m) continue;
        soma += lista[k].pot; peso += 1;
        if (lista[k].restr) {
          if (lista[k].motivo) motivos.add(lista[k].motivo);
          if (lista[k].motivo_cod) cods.add(lista[k].motivo_cod);
        }
      }
      if (!peso) continue;
      slots.set(dia + ' ' + hhmm(s), { pot: soma / peso, cobertura: peso / 30,
        motivos: [...motivos], cods: [...cods] });
    }
  }
  return slots;
}

module.exports = { PLENA, FOLGA, COL, COL_UFV, leEventos, integraliza, codigoMotivo, hhmm, msDe, serialParaDia, fracaoParaMin };
