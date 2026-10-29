'use strict';
/*
 * lib-alarmes-scada.js — a tabela de alarmes do supervisório (Elipse E3, GRL_BancoDados.dbo.Alarms) vira EPISÓDIOS para a tela
 * "Alarmes e ocorrências" (Fase 1, 28/10/2026). Função pura: recebe o texto dos CSV diários e devolve o objeto que o gerador grava.
 * Toda a classificação e a composição moram aqui; o gen-alarmes-scada.js só lista, lê e grava.
 *
 * O ARQUIVO (coleta diária na máquina da usina): `SCADA_DB/bruto/alarmes/<AAAA-MM>/alarms_<AAAA-MM-DD>.csv.gz` no cofre,
 * UTF-8, ';', aspas só quando o campo tem ';', '"' ou quebra de linha. Instantes 'yyyy-MM-dd HH:mm:ss.fff' em hora LOCAL da usina (BRT);
 * OutTime '1899-12-30 …' = sem saída. Cada linha é uma TRANSIÇÃO (entrada, saída, reconhecimento): o episódio se monta aqui.
 *
 * O QUE ENTRA (medido em 21/09 e 27/10/2026: 84–116 mil linhas/dia, ~1,1 mil entradas depois do filtro):
 *   disjuntor   estado de disjuntor da SE ('… DJ … - ESTADO', 'CUB… - SC# - ESTADO'): ABERTO até o próximo FECHADO do mesmo DJ é UM
 *               episódio; INVÁLIDO no meio é evidência (contado), não abre episódio novo;
 *   protecao    trip, atuação, pickup, end fault, SEP na SE;
 *   se_auxiliar tap, gerador diesel, serviço auxiliar;
 *   tcu_alarme  alarme de TCU (bateria, motor, eixo, parada de emergência, bloqueios, falha de sistema…);
 *   ncu         alarme de NCU (vento, anemômetro, gateway, LoRa…) e comando de grupo;
 *   comunicacao comunicação de logger/gateway/driver; a rajada do 'COMUNICAÇÃO LOGGER TS#' do PPC vira UM pai por usina e trecho contínuo;
 *   ppc         subtensão do PPC, controle de reativo bloqueado;
 *   eletrocentro portas, QFA/QFB, RMU, SPD, fumaça, comandos;
 *   inversor_falha / inversor_alarme  PARADO POR FALHA, BOTÃO DE PARADA / ALARME, MODO DE INJEÇÃO HVRT/LVRT (desde 28/10/2026). Para o
 *               INVERSOR a fonte PRIORITÁRIA é o logger Sungrow (código de falha a cada 5 min, traduzido pelo manual): o estado vindo do
 *               supervisório é a SEGUNDA rota, que confirma o evento e dá a hora ao segundo, e vai marcado com a origem.
 *   A FALHA DE COMUNICAÇÃO DE TCU (300–380 TCU distintos por dia, quase todas isoladas) e a REDUÇÃO DE POTÊNCIA do inversor (~940
 *   entradas/dia em 27/10) NÃO vão à lista: viram resumo diário por equipamento.
 * O QUE FICA FORA: a operação normal do inversor (RODANDO, EM ESPERA, INICIANDO, CONECTADO À REDE, DISPATCH RUN) e o 'FALHA', que chega
 *   sempre em par com o PARADO POR FALHA; os estados de operação do TCU (retrocesso, limite de SW, posição segura, sistema OK, partida
 *   permitida, dados salvos) e as permissões de comando da SE.
 * AGRUPAMENTO: o disjuntor de trafo/linha (14Tn, 04Tn, 04L*, 04F*) ABERTO é PAI das proteções do mesmo trafo a ±60 s da abertura e
 *   de todo disjuntor e proteção da SE que ABRE enquanto ele está aberto (21/09: proteção do 04T2 14:10:36 → 14T2 ABERTO 14:10:37 →
 *   11 cubículos 14:36–14:38 → 52.TE32/42 14:39 → 14T2 FECHADO 14:48:29). O disjuntor de cubículo ABERTO é pai das proteções do
 *   MESMO cubículo a ±60 s (27/10 06:23: TRIP GERAL + PROTEÇÃO + END FAULT + ABERTO). Paradas de inversor simultâneas na mesma usina
 *   (3 ou mais, trecho contínuo) viram UM grupo, que vai para dentro do disjuntor que as causou (ver anexaGrupos).
 *
 * FORMATO (curto, sem repetição): `eq` (tag → {u, n, pai}) e `msg` (lista de textos) no topo; cada evento leva só índices e tags:
 *   {id, c: classe, t: tag, i: início, f: fim|null, m: índice em msg, v: valor (ABERTO, ATUADO…), k: transições/invalidos, sv: severidade,
 *    fi: [filhos no mesmo formato], ts: {TSn: [falhas, minutos]} só na rajada do logger, inv: {TSn: ['01', …]} só no grupo de paradas}.
 *   tcu_com e inv_red: [[dia, tag, entradas, minutos]]; estados: [[dia, tag, texto, ocorrências]] (registro de estado e comando da SE);
 *   retx: [[dia, linhas reemitidas descartadas]]; tcu: {'TSn/NCUnn': ['076', …]} só no grupo de alarmes de TCU.
 * REVISÃO DE 29/10/2026 (sessão do Portal, 27+28/10 reais): composição em laço (dois dias estouravam a pilha); cubículo pelo ponto, não
 *   pela Area; reemissão do E3 descartada (`transicao`); registro de estado e comando fora da lista (`SO_ESTADO`); GMG normalmente
 *   aberto; alarmes simultâneos de TCU em grupo, no topo; o reinício do supervisório (28/10 19:46) detectado e marcado `ri`, com os
 *   instantes em `reinicio`; o trafo auxiliar na classe do eletrocentro. Em 27+28/10: nenhum disjuntor falso aberto, nada às 19:46 sem `ri`.
 */

const ESQUEMA = 1;
const JANELA_PAI_S = 60;            // proteção ↔ abertura do mesmo equipamento
const RAJADA_LOGGER_MIN = 10;       // falhas de comunicação de logger do PPC a menos disto viram o mesmo trecho
const SEM_SAIDA = '1899-12-30';
// disjuntor cujo estado NORMAL é aberto: o do gerador de emergência (GMG - DJ Q1), que só fecha quando o gerador assume a carga
// (28/10/2026: FECHADO 07:20:20, ABERTO 07:54:34, com 'GMG - EM OPERAÇÃO' no mesmo intervalo)
const NORMAL_ABERTO = new Set(['GMG']);

/* 🔴 REEMISSÃO NÃO É EVENTO. O E3 regrava o estado dos pontos ativos com o InTime ORIGINAL (28/10/2026 19:46: 9.734 linhas com InTime de
   meses atrás; DJ 14D1 de 29/01, QSA 72.2A/B de 28/07/2025, chaves de terra, local/remoto). A linha é transição só quando o instante
   dela cai no dia do arquivo ou na véspera: a ENTRADA (ConditionActive 1) pelo InTime, a SAÍDA (ConditionActive 0) pelo OutTime. A
   saída de hoje de algo que entrou há meses fica (fecha o episódio); a reemissão de algo ainda ativo sai e é contada em `retx`. */
function transicao(r, dia) {
  const lim = new Date(Date.parse(dia + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);
  const t = r.ConditionActive === '0' ? (r.OutTime && !r.OutTime.startsWith(SEM_SAIDA) ? r.OutTime : r.E3TimeStamp) : (r.InTime || r.E3TimeStamp);
  return (t || '').slice(0, 10) >= lim;
}
/* 🔴 ALARME × REGISTRO DE ESTADO × COMANDO: a configuração do próprio E3 marca cada ponto (coluna EventType; na lista de pontos da SE, a
   coluna TIPO ALARME/EVENTO). Na SE, o registro de estado (EventType 'Event': comutação de tap, MCB de TP ligada, painel CA
   remoto/automático, gerador pronto) e o COMANDO de operador ('Command', em qualquer área) não vão à lista: viram o resumo diário
   `estados` [dia, tag, texto, ocorrências]. O estado de disjuntor (também 'Event') segue na lista, e o 'Event' do TCU (bloqueio
   temporário, por corrente alta, por subtensão, reiniciada) também: é diagnóstico do rastreador. */
/* 🔴 REINÍCIO DO SUPERVISÓRIO. Ao reiniciar, o E3 regrava como ENTRADA NOVA, com o InTime do próprio reinício, tudo o que estava ativo
   (28/10/2026 19:46: 9.009 entradas no minuto, 630 classificadas em 9 classes; 'ALARME TEMPERATURA TRAFO AUX' dos 56 eletrocentros,
   FALHA SPD, RMU em remoto, seleção do PPC…). O minuto de reinício é o que tem REINICIO_N entradas classificadas ou mais em REINICIO_CL
   classes ou mais. Medido em 27–28/10: o maior minuto de evento real teve 159 entradas em 3 classes (27/10 17:08, a manobra) e o trip de
   06:23, 91 em 4. Nesse minuto o episódio aberto leva `ri` (ativo desde antes do reinício: o início real é desconhecido) e não duplica o
   mesmo alarme já aberto antes; a linha de DISJUNTOR do minuto é estado retransmitido e sai. Os instantes vão em `reinicio`. */
const REINICIO_N = 300, REINICIO_CL = 6;
const SO_ESTADO = (r, cl) => (r.EventType === 'Command' && cl !== 'disjuntor') || (r.EventType === 'Event' && cl === 'se_auxiliar');

// ---- CSV ----
// UMA linha por vez (gerador) e só as colunas que a regra usa: o mês cheio do começo de 2025 tem 40–66 mil linhas CLASSIFICADAS por dia
// (falha de comunicação e alarme de TCU), e o mês inteiro com as 19 colunas estourava a memória (fev/2025, 4,3 GB). Os textos que se
// repetem (área, ponto, mensagem, condição, valor) ficam numa cópia só (`intern`, um Map que dura a composição).
const CAMPOS = ['E3TimeStamp', 'InTime', 'OutTime', 'ConditionActive', 'ConditionName', 'FormattedValue', 'Area', 'FullAlarmSourceName', 'Message', 'Severity', 'EventType'];
const REPETE = new Set(['ConditionActive', 'ConditionName', 'FormattedValue', 'Area', 'FullAlarmSourceName', 'Message', 'Severity', 'EventType']);
function* linhasCsv(txt, intern = new Map()) {
  const s = txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt;
  const um = (v) => { const x = intern.get(v); if (x !== undefined) return x; intern.set(v, v); return v; };
  let cab = null, idx = null, campo = '', linha = [], aspas = false;
  const fecha = function* () {
    if (linha.length === 1 && linha[0] === '') return;
    if (!cab) {
      cab = linha;
      for (const c of CAMPOS.filter((c) => c !== 'EventType')) {
        if (!cab.includes(c)) throw new Error('lib-alarmes-scada: CSV sem a coluna ' + c + ' (cabeçalho: ' + cab.slice(0, 6).join(';') + '…)');
      }
      idx = CAMPOS.map((c) => [c, cab.indexOf(c)]).filter(([, k]) => k >= 0);
      return;
    }
    if (linha.length !== cab.length) throw new Error('lib-alarmes-scada: linha com ' + linha.length + ' campos, cabeçalho com ' + cab.length);
    const o = {}; for (const [c, k] of idx) o[c] = REPETE.has(c) ? um(linha[k]) : linha[k];
    yield o;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (aspas) {
      if (ch === '"') { if (s[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === ';') { linha.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; linha.push(campo); campo = ''; yield* fecha(); linha = []; }
    else campo += ch;
  }
  if (campo !== '' || linha.length) { linha.push(campo); yield* fecha(); }
}

// ---- classe ----
const FORA_TCU = /INDICADOR DE RETROCESSO|LIMITE (SUPERIOR|INFERIOR) DE SW ALCAN|POSI..O SEGURA ALCAN|SISTEMA OK|PARTIDA PERMITIDA|DADOS SALVOS/;
function classe(area, msg) {
  const a = area.replace(/\d+/g, '#'), m = msg.replace(/\d+/g, '#');
  if (/\bINV ?#|\.INV\.#|TS# INV#/.test(m)) {                                  // estado de inversor (entra desde 28/10/2026, decisão do humano)
    if (/PARADO POR FALHA|BOT.O DE PARADA/.test(m)) return 'inversor_falha';
    if (/ ALARME$|MODO DE INJECAO [HL]VRT/.test(m)) return 'inversor_alarme';
    if (/REDU..O DE POT/.test(m)) return 'inversor_reducao';
    return null;   // operação normal (RODANDO, EM ESPERA, INICIANDO, CONECTADO À REDE, DISPATCH RUN) e o 'FALHA', gêmeo do PARADO POR FALHA
  }
  if (a.startsWith('GRL.SE_MRT')) {
    if (/PERMISS/.test(m)) return null;
    if (/\bDJ\b.* - ESTADO$|- SC# - ESTADO$/.test(m)) return 'disjuntor';
    if (/TRIP|PROTE|ATUA|PICKUP|END FAULT|SEP/.test(m)) return 'protecao';
    return 'se_auxiliar';
  }
  if (/TCU#/.test(m)) {
    if (FORA_TCU.test(m)) return null;
    return /FALHA DE COMUNICA/.test(m) ? 'tcu_com' : 'tcu_alarme';
  }
  if (/NCU/.test(m) || a.includes('TrackersSTI')) return 'ncu';
  if (/COMUNICA|GATEWAY|DRIVER/.test(m)) return /LOGGER TS#/.test(m) && a.includes('PPC') ? 'logger_ppc' : 'comunicacao';
  if (a.includes('PPC')) return 'ppc';
  // o trafo auxiliar é do eletrocentro (ponto DIDO do TS: 'MRT05 TS1 ALARME TEMPERATURA TRAFO AUX')
  if (/PORTA|FUMA|SPD|QF[AB]|QS[AB]|RMU|DJ TS|COMANDO|TRAFO AUX/.test(m)) return 'eletrocentro';
  return 'outro';
}

// ---- equipamento ----
const USINA = (mrt) => (mrt === '10' ? 'M1' : 'M' + Number(mrt));
// cubículo → usina: os circuitos por usina vêm do lib-scada-db.js (uma escrita só)
const CUB_USINA = Object.freeze(Object.fromEntries(Object.entries(require('./lib-scada-db').CIRCUITOS)
  .flatMap(([u, cubs]) => cubs.map((c) => ['CUB' + c, u]))));
const DO_TRAFO = { M1: '04T1', M2: '04T1', M5: '04T1', M6: '04T1', M3: '04T2', M4: '04T2', M7: '04T2', M8: '04T2', M9: '04T2' };
// o cubículo sai do PONTO (FullAlarmSourceName 'SE_MRT.CUB11_2.…' ou a mensagem 'CUB11_2- …'); a Area só quando o ponto não diz: o E3 tem
// Area trocada em pontos de SC (27/10/2026 17:11:57, 'CUB11_2- SC1 - ESTADO' com Area GRL.SE_MRT.[CUB10-2]; 97 linhas em 27 e 28/10)
const CUB_DO_PONTO = (r) => { const x = (r.FullAlarmSourceName || '').match(/(?:^|\.)SE_MRT\.(CUB\d+_\d+)\./) || (r.Message || '').match(/^(CUB\d+_\d+)\s*-/);
  return x ? x[1] : null; };
function equipamento(r) {
  const area = r.Area || '';
  let x = area.match(/^GRL\.SE_MRT\.\[([^\]]+)\]/);
  if (x) {
    const tag = CUB_DO_PONTO(r) || x[1].replace(/^CUB(\d+)-(\d+)$/, 'CUB$1_$2');
    const u = CUB_USINA[tag] || 'SE';
    const n = /^CUB/.test(tag) ? 'cubiculo' : /^(04|14)T\d$/.test(tag) ? 'trafo' : /^04[LF]/.test(tag) ? 'linha' : 'se';
    return { tag, u, n, pai: n === 'cubiculo' && DO_TRAFO[u] ? DO_TRAFO[u] : 'SE' };
  }
  const inv = (r.Message || '').match(/^MRT(\d{2})\s+TS(\d+)\s+INV(\d+)\b/);
  if (inv) { const u = USINA(inv[1]), ts = u + '/TS' + Number(inv[2]); return { tag: ts + '/INV' + inv[3].padStart(2, '0'), u, n: 'inversor', pai: ts }; }
  x = area.match(/MRT(\d{2})\.TS(\d+)(?:\.NCU(\d+))?/) || (r.FullAlarmSourceName || '').match(/MRT(\d{2})\.TS(\d+)(?:\.NCU(\d+))?/);
  const tcu = (r.Message || '').match(/TCU(\d+)/);
  if (x) {
    const u = USINA(x[1]), ts = u + '/TS' + x[2];
    if (tcu && x[3]) return { tag: ts + '/NCU' + x[3] + '/TCU' + tcu[1], u, n: 'tcu', pai: ts + '/NCU' + x[3] };
    if (x[3]) return { tag: ts + '/NCU' + x[3], u, n: 'ncu', pai: ts };
    return { tag: ts, u, n: 'eletrocentro', pai: u };
  }
  x = area.match(/PPC\.MRT(\d{2})/) || (r.Message || '').match(/^MRT(\d{2})\b/);
  if (x) return { tag: USINA(x[1]), u: USINA(x[1]), n: 'usina', pai: 'Complexo' };
  return { tag: 'Complexo', u: 'Complexo', n: 'complexo', pai: null };
}

// ---- tempo ----
const iso = (s) => (s && !s.startsWith(SEM_SAIDA) ? s.slice(0, 19).replace(' ', 'T') : null);
const ms = (s) => (s ? Date.parse(s + '-03:00') : NaN);
const texto = (r) => (r.Message || '').replace(/^MRT\d{2}\s+TS\d+\s+(NCU\d+|TCU\d+|INV\d+)\s+/, '').replace(/^MRT\d{2}\s+(TS\d+\s+)?/, '')
  .replace(/^CUB\d+_\d+-\s*/, '').trim() || (r.ConditionName || '');

// ---- episódios ----
// `semente`: disjuntores ainda ABERTOS na publicação anterior ({tag, m, i, k, sv, eq}), para o FECHADO de hoje fechar a abertura de
// dias atrás (o M9C1 ficou semanas aberto em 2025). A chave do disjuntor é tag + texto, a mesma que se refaz do publicado.
function episodios(rows, semente = []) {
  const cond = new Map();
  const ordem = rows.map((r) => ({ r, cl: classe(r.Area || '', r.Message || '') })).filter((x) => x.cl)
    .sort((a, b) => (a.r.E3TimeStamp < b.r.E3TimeStamp ? -1 : a.r.E3TimeStamp > b.r.E3TimeStamp ? 1 : 0));
  const djAbertos = new Map(), djEv = [];
  for (const s of semente) { const e = { cl: 'disjuntor', eq: s.eq, i: s.i, f: null, m: s.m, v: s.v || 'ABERTO', k: s.k || 0, sv: s.sv }; djAbertos.set(s.eq.tag + '|' + s.m, e); djEv.push(e); }
  for (const { r, cl } of ordem) {
    const eq = equipamento(r);
    if (cl === 'disjuntor') {
      const chave = eq.tag + '|' + texto(r), v = (r.FormattedValue || '').toUpperCase(), t = iso(r.InTime) || iso(r.E3TimeStamp);
      const ab = djAbertos.get(chave);
      // o disjuntor NORMALMENTE ABERTO (gerador de emergência) tem o episódio ao contrário: FECHADO (em carga) até o ABERTO
      const [anormal, normal] = NORMAL_ABERTO.has(eq.tag) ? [/^FECHADO/, /^ABERTO/] : [/^ABERTO/, /^FECHADO/];
      if (anormal.test(v)) { if (!ab) { const e = { cl, eq, i: t, f: null, m: texto(r), v: v.split(/\s/)[0], k: 0, sv: r.Severity }; djAbertos.set(chave, e); djEv.push(e); } }
      else if (normal.test(v)) { if (ab) { ab.f = t; djAbertos.delete(chave); } }
      else if (ab) ab.k++;                                                    // INVÁLIDO (ou outro) no meio: evidência
      continue;
    }
    const ini = iso(r.InTime) || iso(r.E3TimeStamp);
    const chave = (r.FullAlarmSourceName || r.Area) + '|' + (r.ConditionName || r.Message) + '|' + ini;
    let e = cond.get(chave);
    if (!e) { e = { cl, eq, i: ini, f: null, m: texto(r), v: r.FormattedValue || '', k: 0, sv: r.Severity }; if (r._ri) e.ri = 1; cond.set(chave, e); }
    e.k++;
    if (r.ConditionActive === '0') e.f = iso(r.OutTime) || iso(r.E3TimeStamp);
  }
  return [...djEv, ...cond.values()];
}

// resumo por dia e equipamento (entradas, minutos no estado, recortados no dia): TCU sem comunicação ('tcu_com') e redução de potência
// do inversor ('inversor_reducao', ~940 entradas/dia em 27/10/2026)
function resumoDiario(eps, ateIso, cl = 'tcu_com') {
  const por = new Map(), fimJanela = ms(ateIso);
  for (const e of eps.filter((x) => x.cl === cl)) {
    let a = ms(e.i); const b = e.f ? ms(e.f) : fimJanela;
    while (a < b) {
      const dia = new Date(a - 3 * 3600e3).toISOString().slice(0, 10), fimDia = Date.parse(dia + 'T24:00:00-03:00');
      const k = dia + '|' + e.eq.tag, x = por.get(k) || [dia, e.eq.tag, 0, 0];
      if (a === ms(e.i)) x[2]++;
      x[3] += (Math.min(b, fimDia) - a) / 60000; por.set(k, x); a = fimDia;
    }
  }
  return [...por.values()].map((x) => [x[0], x[1], x[2], Math.round(x[3])]).sort((p, q) => (p[0] + p[1] < q[0] + q[1] ? -1 : 1));
}

// paradas de inversor por falha AO MESMO TEMPO são consequência de um evento da rede (21/09/2026: 2.471 das 2.497 às 14h, o 14T2;
// 27/10: 78 às 06h e 243 às 17h, as duas aberturas da barra 4). Por usina, trecho contínuo (gap ≤ GRUPO_INV_MIN) com GRUPO_INV_N
// inversores ou mais vira UM grupo `inv: {TSn: ['01', '05', …]}`; a parada isolada segue como evento próprio.
// O mesmo vale para ALARME e HVRT/LVRT do inversor no distúrbio (21/09 14:10: ~50 alarmes no mesmo minuto), em grupo próprio.
const GRUPO_INV_N = 3, GRUPO_INV_MIN = 10;
const TEXTO_GRUPO = { inversor_falha: 'PARADA DE INVERSORES (grupo)', inversor_alarme: 'ALARME DE INVERSORES (grupo)' };
// O ALARME DE TCU segue a mesma regra, por texto (27–28/10/2026: 246 'PARADA DE EMERGÊNCIA' em dois dias, a maioria em rajadas de vários
// TCU do mesmo eletrocentro): grupo `tcu: {'TSn/NCUnn': ['076', …]}` com o texto do alarme; o TCU isolado segue como evento próprio.
function agrupaInversor(eps) {
  const grupos = [], dentro = new Set(), por = new Map();
  const doTcu = (e) => e.cl === 'tcu_alarme';
  // o regravado no reinício (`ri`) não é disparo simultâneo: fica fora dos grupos
  for (const e of eps.filter((x) => !x.ri && (x.cl in TEXTO_GRUPO || doTcu(x))).sort((a, b) => ms(a.i) - ms(b.i))) {
    const ch = e.cl + '|' + e.eq.u + (doTcu(e) ? '|' + e.m : '');
    let g = por.get(ch);
    if (!g || ms(e.i) > g.fimIni + GRUPO_INV_MIN * 60000) { g = { cl: e.cl, u: e.eq.u, m: e.m, mem: [], fimIni: 0 }; por.set(ch, g); grupos.push(g); }
    g.mem.push(e); g.fimIni = ms(e.i);
  }
  const sai = [];
  for (const g of grupos) {
    if (new Set(g.mem.map((e) => e.eq.tag)).size < GRUPO_INV_N) continue;
    const tcu = g.cl === 'tcu_alarme', lista = {};
    for (const e of g.mem) {
      const p = e.eq.tag.split('/'), ch = tcu ? p[1] + '/' + p[2] : p[1], it = tcu ? p[3].slice(3) : p[2].slice(3);
      (lista[ch] = lista[ch] || []).includes(it) || lista[ch].push(it); dentro.add(e);
    }
    Object.values(lista).forEach((l) => l.sort());
    const f = g.mem.some((e) => !e.f) ? null : g.mem.reduce((a, e) => (e.f > a ? e.f : a), g.mem[0].f);
    sai.push({ cl: g.cl, eq: { tag: g.u, u: g.u, n: 'usina', pai: 'Complexo' }, i: g.mem[0].i, f, m: tcu ? g.m + ' (grupo)' : TEXTO_GRUPO[g.cl], v: '',
      k: g.mem.length, [tcu ? 'tcu' : 'inv']: lista });
  }
  return { grupos: sai, dentro };
}

// o grupo de paradas vai para dentro do disjuntor que o causou: cubículo da MESMA usina aberto a ±5 min do início do grupo; senão o
// disjuntor de trafo/linha aberto cujo início está a −60 s/+5 min do grupo (o distúrbio para inversores de todo o complexo, 21/09) ou
// cujo intervalo aberto contém o grupo, se a usina é desse trafo. Sem disjuntor perto, o grupo fica no topo da lista.
function anexaGrupos(grupos, eps) {
  const pais = eps.filter((e) => e.cl === 'disjuntor' && e.fi);
  const fora = [];
  for (const g of grupos) {
    if (g.tcu) { fora.push(g); continue; }                                     // o TCU tem bateria própria: a abertura não o explica
    const t = ms(g.i);
    const cub = pais.find((p) => p.eq.n === 'cubiculo' && p.eq.u === g.eq.u && Math.abs(ms(p.i) - t) <= 5 * 60000);
    const tr = pais.find((p) => (p.eq.n === 'trafo' || p.eq.n === 'linha') && ((t >= ms(p.i) - 60000 && t <= ms(p.i) + 5 * 60000)
      || (DO_TRAFO[g.eq.u] && p.eq.tag.endsWith(DO_TRAFO[g.eq.u].slice(-1)) && t >= ms(p.i) && t <= (p.f ? ms(p.f) : Infinity))));
    const alvo = cub || tr;
    if (alvo) alvo.fi.push(g); else fora.push(g);
  }
  return fora;
}

// rajada do logger do PPC: um pai por usina e trecho contínuo (episódios que se tocam ou distam ≤ RAJADA_LOGGER_MIN). Os filhos NÃO
// vão um a um (27/10: 231 falhas do M8 numa noite): o pai leva o resumo por eletrocentro `ts: {TSn: [falhas, minutos]}`.
function agrupaLogger(eps) {
  const sai = [], por = new Map(), fim = (x) => (x.f ? ms(x.f) : Infinity);
  for (const e of eps.filter((x) => x.cl === 'logger_ppc').sort((a, b) => ms(a.i) - ms(b.i))) {
    let g = por.get(e.eq.u);
    if (!g || ms(e.i) > g.fimMs + RAJADA_LOGGER_MIN * 60000) {
      g = { cl: 'comunicacao', eq: { tag: e.eq.u, u: e.eq.u, n: 'usina', pai: 'Complexo' }, i: e.i, f: null, m: 'COMUNICAÇÃO LOGGER (rajada)',
        v: '', k: 0, ts: {}, fimMs: -Infinity, aberto: false };
      por.set(e.eq.u, g); sai.push(g);
    }
    const ts = ((e.m || '').match(/TS\d+/) || ['TS?'])[0], x = g.ts[ts] || (g.ts[ts] = [0, 0]);
    x[0]++; if (e.f) x[1] += (ms(e.f) - ms(e.i)) / 60000;
    g.k++; g.fimMs = Math.max(g.fimMs, fim(e)); if (!e.f) g.aberto = true;
  }
  for (const p of sai) {
    p.f = p.aberto ? null : new Date(p.fimMs - 3 * 3600e3).toISOString().slice(0, 19);
    for (const v of Object.values(p.ts)) v[1] = Math.round(v[1]);
    delete p.fimMs; delete p.aberto;
  }
  return sai;
}

// pai/filhos: disjuntor de trafo/linha e disjuntor de cubículo
function agrupaSe(eps) {
  const dj = eps.filter((e) => e.cl === 'disjuntor'), prot = eps.filter((e) => e.cl === 'protecao');
  const dentro = new Set();
  const trafoDe = (tag) => (/^(04|14)T(\d)$/.test(tag) ? tag.slice(-1) : null);
  const pais = dj.filter((e) => e.eq.n === 'trafo' || e.eq.n === 'linha').sort((a, b) => ms(a.i) - ms(b.i));
  for (const p of pais) {
    p.fi = [];
    const a = ms(p.i), b = p.f ? ms(p.f) : Infinity, n = trafoDe(p.eq.tag);
    for (const x of prot) if (!dentro.has(x) && n && trafoDe(x.eq.tag) === n && Math.abs(ms(x.i) - a) <= JANELA_PAI_S * 1000) { p.fi.push(x); dentro.add(x); }
    for (const x of [...dj, ...prot]) if (x !== p && !dentro.has(x) && !pais.includes(x) && ms(x.i) > a && ms(x.i) < b) { p.fi.push(x); dentro.add(x); }
  }
  for (const p of dj.filter((e) => e.eq.n === 'cubiculo' && !dentro.has(e))) {
    p.fi = prot.filter((x) => !dentro.has(x) && x.eq.tag === p.eq.tag && Math.abs(ms(x.i) - ms(p.i)) <= JANELA_PAI_S * 1000);
    p.fi.forEach((x) => dentro.add(x));
  }
  // filho de cubículo que entrou num pai de trafo leva junto as proteções dele
  for (const p of pais) for (const c of p.fi.filter((x) => x.cl === 'disjuntor' && x.eq.n === 'cubiculo')) {
    c.fi = prot.filter((x) => !dentro.has(x) && x.eq.tag === c.eq.tag && Math.abs(ms(x.i) - ms(c.i)) <= JANELA_PAI_S * 1000);
    c.fi.forEach((x) => dentro.add(x));
  }
  return dentro;
}

// ---- composição: CSV dos dias → objeto publicado ----
// textos: [{dia, txt}] em qualquer ordem (o dia anterior à janela entra para fechar o que atravessa a meia-noite);
// de/ate: janela publicada (AAAA-MM-DD, inclusivo); anterior: a publicação anterior (o mês anterior, ou null). Dela vêm o disjuntor
// ainda ABERTO (semente, para o FECHADO de hoje fechá-lo) e os outros episódios ainda sem fim que começaram antes do 1º dia lido
// (seguem como estão até a linha de saída deles chegar, que refaz o mesmo id com o fim).
function compoe(textos, de, ate, { gerado = null, anterior = null } = {}) {
  const ord = textos.slice().sort((a, b) => (a.dia < b.dia ? -1 : 1));
  // laço, nunca push(...lista): dois dias reais (255 mil linhas) estouram a pilha no espalhamento
  const rows = [], retx = [], est = new Map(), eqEst = new Map();
  for (const { dia, txt } of ord) {
    let n = 0;
    for (const r of linhasCsv(txt)) {
      if (!transicao(r, dia)) { n++; continue; }
      const cl = classe(r.Area || '', r.Message || '');
      // a linha sem classe (operação normal do inversor, estado de TCU…) sai JÁ: o mês inteiro com elas estoura a memória (fev/2025, 4 GB)
      if (!cl) continue;
      if (SO_ESTADO(r, cl)) {
        if (r.ConditionActive === '0') continue;                                // o estado conta na entrada
        const e = equipamento(r), t = e.tag, d = (iso(r.InTime) || iso(r.E3TimeStamp)).slice(0, 10), m = texto(r), k = d + '|' + t + '|' + m;
        eqEst.set(t, { u: e.u, n: e.n, pai: e.pai });
        const x = est.get(k) || [d, t, m, 0]; x[3]++; est.set(k, x); continue;
      }
      rows.push(r);
    }
    if (n) retx.push([dia, n]);
  }
  // o minuto de reinício (ver REINICIO_N): marca as entradas dele e tira as linhas de disjuntor
  const porMin = new Map();
  for (const r of rows) {
    const cl = r.ConditionActive === '1' && classe(r.Area || '', r.Message || '');
    if (!cl) continue;
    const m = (r.InTime || r.E3TimeStamp).slice(0, 16), x = porMin.get(m) || porMin.set(m, { n: 0, cl: new Set() }).get(m);
    x.n++; x.cl.add(cl);
  }
  const reinicio = [...porMin].filter(([, x]) => x.n >= REINICIO_N && x.cl.size >= REINICIO_CL).map(([m]) => m).sort();
  if (reinicio.length) {
    const noMin = (r) => reinicio.includes((r.InTime || r.E3TimeStamp).slice(0, 16));
    for (let k = rows.length - 1; k >= 0; k--) {
      const r = rows[k];
      if (r.ConditionActive !== '1' || !noMin(r)) continue;
      if (classe(r.Area || '', r.Message || '') === 'disjuntor') rows.splice(k, 1); else r._ri = 1;
    }
  }
  const lido0 = (ord[0] ? ord[0].dia : de) + 'T00:00:00';
  // 🔴 só se herda o que estava aberto quando a publicação anterior ENCOSTA no 1º dia lido (o último dia dela é a véspera dele, ou
  // depois). Com dias sem arquivo no meio, o fim do que estava aberto é desconhecido e nada atravessa o buraco: em 29/10/2026 o cofre
  // ainda não tinha abr/2025–set/2026, e os ~15,8 mil alarmes abertos no fim de mar/2025 apareciam como ativos em out/2026.
  const ultAnt = anterior && (anterior.dias || []).length ? anterior.dias[anterior.dias.length - 1] : null;
  const encosta = !!ultAnt && new Date(Date.parse(ultAnt + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10) >= lido0.slice(0, 10);
  const antAbertos = anterior && encosta ? anterior.ev.filter((o) => o.f === null && o.i < lido0) : [];
  const semente = antAbertos.filter((o) => o.c === 'disjuntor').map((o) => ({ eq: { tag: o.t, ...anterior.eq[o.t] }, m: anterior.msg[o.m], i: o.i, k: o.k, sv: o.sv, v: o.v }));
  // o alarme regravado no reinício que já estava aberto (nesta leitura, antes do reinício, ou na publicação anterior) não duplica
  const abertos = new Map();
  for (const o of antAbertos) if (o.c !== 'disjuntor') abertos.set(o.t + '|' + anterior.msg[o.m], [{ i: o.i, f: null }]);
  const eps0 = episodios(rows, semente);
  for (const e of eps0) if (!e.ri) { const k = e.eq.tag + '|' + e.m; (abertos.get(k) || abertos.set(k, []).get(k)).push(e); }
  const eps = eps0.filter((e) => !e.ri || !(abertos.get(e.eq.tag + '|' + e.m) || []).some((x) => ms(x.i) < ms(e.i) && (!x.f || ms(x.f) >= ms(e.i))));
  const fimJanela = ate + 'T23:59:59';
  const tcu = resumoDiario(eps, fimJanela, 'tcu_com').filter((x) => x[0] >= de && x[0] <= ate);
  const red = resumoDiario(eps, fimJanela, 'inversor_reducao').filter((x) => x[0] >= de && x[0] <= ate);
  const logger = agrupaLogger(eps);
  const inv = agrupaInversor(eps);
  const dentro = agrupaSe(eps);
  const gruposFora = anexaGrupos(inv.grupos, eps);
  const lista = [...eps.filter((e) => !['tcu_com', 'logger_ppc', 'inversor_reducao'].includes(e.cl) && !dentro.has(e) && !inv.dentro.has(e)), ...logger, ...gruposFora]
    .filter((e) => (e.f || fimJanela) >= de + 'T00:00:00' && e.i <= fimJanela)
    .sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : a.eq.tag < b.eq.tag ? -1 : 1));
  const eqDic = {}, msgs = [], mIdx = new Map();
  const idx = (m) => { if (!mIdx.has(m)) { mIdx.set(m, msgs.length); msgs.push(m); } return mIdx.get(m); };
  const fmt = (e) => {
    eqDic[e.eq.tag] = { u: e.eq.u, n: e.eq.n, pai: e.eq.pai };
    const o = { id: e.cl + ':' + e.eq.tag + ':' + e.i + ':' + idx(e.m), c: e.cl, t: e.eq.tag, i: e.i, f: e.f, m: idx(e.m) };
    if (e.v) o.v = e.v; if (e.k > 1 || (e.cl === 'disjuntor' && e.k)) o.k = e.k; if (e.sv && e.sv !== '0') o.sv = Number(e.sv);
    if (e.fi && e.fi.length) o.fi = e.fi.sort((a, b) => (a.i < b.i ? -1 : 1)).map(fmt);
    if (e.ts) o.ts = e.ts;
    if (e.inv) o.inv = e.inv;
    if (e.tcu) o.tcu = e.tcu;
    if (e.ri) o.ri = 1;
    return o;
  };
  // o id leva o texto curto (estável entre rodadas). Duas origens com o mesmo texto no mesmo segundo no mesmo equipamento (27/10: o
  // PICKUP do 04T2 duas vezes) são UM evento: o 2º só soma a contagem.
  const porId = new Map();
  const junta = (arr) => { const out = []; for (const o of arr) { const x = porId.get(o.id); if (x) { x.k = (x.k || 1) + (o.k || 1); continue; } porId.set(o.id, o); out.push(o); } return out; };
  const estavel = (o) => { o.id = o.c + ':' + o.t + ':' + o.i + ':' + msgs[o.m]; if (o.fi) { o.fi.forEach(estavel); o.fi = junta(o.fi); } };
  const ev0 = lista.map(fmt); ev0.forEach(estavel);
  const ev = junta(ev0);
  // os ainda sem fim do anterior que não foram refeitos aqui (nem por semente nem pela linha de saída) seguem como estavam
  const reindexa = (o) => { const n = { ...o, m: idx(anterior.msg[o.m]) }; if (o.fi) n.fi = o.fi.map(reindexa); eqDic[o.t] = anterior.eq[o.t]; return n; };
  for (const o of antAbertos) if (o.c !== 'disjuntor' && !porId.has(o.id)) { const n = reindexa(o); porId.set(n.id, n); ev.push(n); }
  ev.sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : a.t < b.t ? -1 : 1));
  for (const [, tag] of tcu) { const p = tag.split('/'); eqDic[tag] = { u: p[0], n: 'tcu', pai: p.slice(0, 3).join('/') }; }
  for (const [, tag] of red) { const p = tag.split('/'); eqDic[tag] = { u: p[0], n: 'inversor', pai: p.slice(0, 2).join('/') }; }
  const estados = [...est.values()].filter((x) => x[0] >= de && x[0] <= ate).sort((p, q) => (p[0] + p[1] + p[2] < q[0] + q[1] + q[2] ? -1 : 1));
  for (const [, tag] of estados) if (!eqDic[tag]) eqDic[tag] = eqEst.get(tag);
  const dias = ord.map((x) => x.dia).filter((d) => d >= de && d <= ate);
  return { esquema: ESQUEMA, fonte: 'supervisorio', gerado, janela: { de, ate }, dias, eq: eqDic, msg: msgs, ev, tcu_com: tcu, inv_red: red,
    estados, retx: retx.filter((x) => x[0] >= de && x[0] <= ate), reinicio: reinicio.map((m) => m.replace(' ', 'T')).filter((m) => m.slice(0, 10) >= de && m.slice(0, 10) <= ate) };
}

// a janela publicada (7 dias) a partir das publicações mensais: junta, recorta e refaz os dicionários (só o que a janela usa)
function recorta(objs, de, ate, { gerado = null } = {}) {
  const fimJ = ate + 'T23:59:59', iniJ = de + 'T00:00:00', porId = new Map(), msgs = [], mIdx = new Map(), eq = {};
  const idx = (m) => { if (!mIdx.has(m)) { mIdx.set(m, msgs.length); msgs.push(m); } return mIdx.get(m); };
  for (const o of objs) for (const e of o.ev) if ((e.f || fimJ) >= iniJ && e.i <= fimJ) porId.set(e.id, { e, o });   // o mês mais novo ganha
  const re = (e, o) => { eq[e.t] = o.eq[e.t]; const n = { ...e, m: idx(o.msg[e.m]) }; if (e.fi) n.fi = e.fi.map((x) => re(x, o)); return n; };
  const ev = [...porId.values()].map(({ e, o }) => re(e, o)).sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : a.t < b.t ? -1 : 1));
  // `chave`: quantas posições identificam a linha (dia + tag; nos estados, + texto). O mês mais novo ganha
  const resumo = (campo, chave = 2) => {
    const out = [], vistos = new Set();
    for (const o of objs.slice().reverse()) for (const x of o[campo] || []) {
      const k = x.slice(0, chave).join('|'); if (x[0] < de || x[0] > ate || vistos.has(k)) continue; vistos.add(k); out.push(x);
      if (chave > 1 && o.eq) eq[x[1]] = o.eq[x[1]];
    }
    return out.sort((p, q) => (p.slice(0, chave).join('|') < q.slice(0, chave).join('|') ? -1 : 1));
  };
  const tcu = resumo('tcu_com'), red = resumo('inv_red'), estados = resumo('estados', 3), retx = resumo('retx', 1);
  const dias = [...new Set(objs.flatMap((o) => o.dias || []))].filter((d) => d >= de && d <= ate).sort();
  const reinicio = [...new Set(objs.flatMap((o) => o.reinicio || []))].filter((m) => m.slice(0, 10) >= de && m.slice(0, 10) <= ate).sort();
  return { esquema: ESQUEMA, fonte: 'supervisorio', gerado, janela: { de, ate }, dias, eq, msg: msgs, ev, tcu_com: tcu, inv_red: red, estados, retx, reinicio };
}

// versão do arquivo por dia: o nome sem sufixo é a 1ª; '~AAAAMMDD-HHMMSS' é versão posterior (sobe_azure.py). A mais nova vence.
function escolheVersoes(nomes) {
  const por = new Map();
  for (const n of nomes) {
    const x = n.match(/alarms_(\d{4}-\d{2}-\d{2})\.csv\.gz(?:~(\d{8}-\d{6}))?$/);
    if (!x) { if (/alarms_/.test(n)) throw new Error('lib-alarmes-scada: nome de arquivo não reconhecido: ' + n); continue; }
    const v = x[2] || '', atual = por.get(x[1]);
    if (!atual || v > atual.v) por.set(x[1], { nome: n, v });
  }
  return new Map([...por.entries()].sort().map(([d, x]) => [d, x.nome]));
}

module.exports = { ESQUEMA, linhasCsv, classe, equipamento, episodios, resumoDiario, agrupaInversor, anexaGrupos, agrupaLogger, agrupaSe, compoe, recorta,
  escolheVersoes };
