/*
 * lib-disponibilidade.js — disponibilidade POR USINA, medida no proprio inversor.
 *
 * DE ONDE VEM: o supervisorio publica, por inversor e por dia, o TEMPO DE OPERACAO DIARIO (em
 * minutos). Um inversor que operou o dia inteiro marca a janela de sol (~12,3 h em Mauriti); um
 * que parou marca menos. A razao entre o que ele operou e a janela do dia e a disponibilidade
 * dele; a da usina e a media dos inversores (todos SG350HX, mesma capacidade, entao media simples).
 *
 * 🔴 A JANELA DO DIA E MEDIDA, NAO SUPOSTA — e e a MEDIANA do complexo inteiro, nao o maximo nem
 *    o p90. Medido em 06/09/2026, 42 dias: a mediana do tempo de operacao fica entre 11,98 e 12,42 h
 *    em todos os dias (o sol de Mauriti). O p90 NAO serve: em M4, M5, M6 e M9 ha transformadores
 *    inteiros cujos inversores marcam ~23,5 h todo dia, e o p90 contaminado por eles jogava a
 *    disponibilidade do M4 a 87% e a do M9 a 68% com as usinas intactas.
 *
 * 🔴 O CONTADOR DE 24 H NAO E INDISPONIBILIDADE. Sao inversores cujo contador nao zera a noite
 *    (M4/TS7 os 22, M5/TS1-4, M6/TS1,3,4, M9/TS1): geram exatamente como os pares — razao de energia
 *    contra a mediana dos vizinhos = 1,000 (n = 3.987 inversor-dias). Entram como DISPONIVEIS e a
 *    contagem deles e publicada, para o dia em que a semantica do contador mudar aparecer.
 *
 * VALIDADO CONTRA A ENERGIA: nos inversores com menos de 95% da janela, a fracao de horas e a
 * razao de energia contra os pares andam juntas (r = 0,675, n = 73); a energia cai menos que as
 * horas (0,858 contra 0,753) porque a parada tende a cair nas pontas do dia, que valem menos.
 *
 * O QUE ISTO NAO E: a disponibilidade DECLARADA ao operador nacional (disp_pct do executivo), que
 * e capacidade disponivel declarada no nivel do conjunto. As duas medem coisas parecidas por
 * caminhos independentes — em ago/26, 99,81% aqui contra ~99,7% la — e por isso convivem.
 */
const LIMITE_DIURNO_MIN = 900;     // acima de 15 h o contador e de outra natureza (24 h)
const MIN_DIURNOS = 50;            // menos que isso e dia sem base para medir a janela
const JANELA_MIN = 600, JANELA_MAX = 840;   // 10 a 14 h: fora disso o dado nao e o que se pensa
const PARADO = 0.5, PARCIAL = 0.9;

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * @param {Array<{dia:string, ufv:string, ts?:string, inv?:string, horas:number}>} linhas
 *   uma linha por inversor por dia; `horas` e o tempo de operacao diario em MINUTOS
 * @returns {{ porDia: Map<string, {janela_min:number|null, porUfv:Object, complexo:Object|null, nota?:string}> }}
 */
function disponibilidade(linhas) {
  const porDia = new Map();
  for (const l of linhas) {
    if (l == null || l.horas == null || !isFinite(l.horas)) continue;
    if (!porDia.has(l.dia)) porDia.set(l.dia, []);
    porDia.get(l.dia).push(l);
  }
  const out = new Map();
  for (const [dia, arr] of porDia) {
    const diurno = arr.filter((l) => l.horas <= LIMITE_DIURNO_MIN).map((l) => l.horas).sort((a, b) => a - b);
    const res = { janela_min: null, porUfv: {}, complexo: null };
    if (diurno.length < MIN_DIURNOS) { res.nota = 'poucos inversores com contador diurno (' + diurno.length + ')'; out.set(dia, res); continue; }
    const ref = diurno[diurno.length >> 1];
    if (!(ref >= JANELA_MIN && ref <= JANELA_MAX)) {
      res.nota = 'janela do dia fora de 10-14 h (' + r2(ref / 60) + ' h): o contador nao e o que se pensa';
      out.set(dia, res); continue;
    }
    res.janela_min = ref;
    const porU = {};
    for (const l of arr) (porU[l.ufv] = porU[l.ufv] || []).push(l);
    let sCx = 0, nCx = 0;
    for (const [ufv, L] of Object.entries(porU)) {
      let soma = 0, parados = 0, parciais = 0, c24 = 0;
      for (const l of L) {
        let f;
        if (l.horas > LIMITE_DIURNO_MIN) { f = 1; c24++; }
        else f = Math.min(l.horas, ref) / ref;
        soma += f;
        if (f < PARADO) parados++; else if (f < PARCIAL) parciais++;
      }
      porUfvSet(res.porUfv, ufv, { disp_pct: r2(100 * soma / L.length), n: L.length, parados, parciais, contador_24h: c24 });
      sCx += soma; nCx += L.length;
    }
    res.complexo = nCx ? { disp_pct: r2(100 * sCx / nCx), n: nCx } : null;
    out.set(dia, res);
  }
  return { porDia: out };
}
function porUfvSet(o, k, v) { o[k] = v; }

/** media por (ufv, mes) sobre os dias; grupos ponderados pelo numero de inversores do dia */
function mensal(porDia, grupos) {
  const acc = {};   // ufv|mes -> { s, n, dias }
  const add = (k, disp, n) => { const o = acc[k] || (acc[k] = { s: 0, n: 0, dias: 0 }); o.s += disp * n; o.n += n; o.dias++; };
  for (const [dia, r] of porDia) {
    if (r.janela_min == null) continue;
    const mes = dia.slice(0, 7);
    for (const [ufv, x] of Object.entries(r.porUfv)) add(ufv + '|' + mes, x.disp_pct, x.n);
    for (const [g, membros] of Object.entries(grupos || {})) {
      let s = 0, n = 0;
      for (const u of membros) { const x = r.porUfv[u]; if (x) { s += x.disp_pct * x.n; n += x.n; } }
      if (n) add(g + '|' + mes, s / n, n);
    }
  }
  const out = {};
  for (const [k, o] of Object.entries(acc)) out[k] = { disp_pct: r2(o.s / o.n), dias: o.dias };
  return out;
}

// 🔴 A DISPONIBILIDADE VOLTA PARA OS DIAS QUE JA ESTAVAM NO BLOB SEM ELA.
//    O campo nasceu em 06/09/2026. Os dias gravados ANTES disso ficaram no `perdas_diario` para
//    sempre sem ele — nao porque o acumulador os pule (ele nao pula: "a rodada nova sempre GANHA
//    na colisao"), mas porque o gerador so LE os arquivos brutos dos ultimos DIAS carimbos, e a
//    fonte guarda 30 dias. Dia que saiu da janela da fonte nunca mais e recalculado.
//    Medido em 11/09/2026: 11 dias (23/07 a 02/08) sem `*_disp_pct` no diario — e com as 1.104
//    linhas de contador COMPLETAS no `perdas_inv` publicado, nas nove usinas. A materia-prima
//    estava em casa; faltava alguem le-la.
//    ⚠️ Preenche SO o que falta: linha que ja tem o campo nao e tocada. E a janela de cada dia e
//    calculada DENTRO daquele dia (`lib-disponibilidade`, laco por dia), entao alimentar a funcao
//    com mais dias nao mexe em nenhum valor ja publicado.
function completaDisponibilidade(serie, DISP, us, r2) {
  let n = 0;
  for (const o of serie) {
    const R = DISP.get(o.dia);
    if (!R) continue;
    let mexeu = false;
    for (const ufv of us) {
      const dv = R.porUfv[ufv];
      if (dv && o[ufv + '_disp_pct'] == null) {
        o[ufv + '_disp_pct'] = dv.disp_pct;
        o[ufv + '_inv_parados'] = dv.parados;
        o[ufv + '_inv_parciais'] = dv.parciais;
        o[ufv + '_inv_contador_24h'] = dv.contador_24h;
        mexeu = true;
      }
    }
    if (R.janela_min != null && o.janela_h == null) { o.janela_h = r2(R.janela_min / 60); mexeu = true; }
    if (R.complexo && o.CX_disp_pct == null) { o.CX_disp_pct = R.complexo.disp_pct; mexeu = true; }
    if (mexeu) n++;
  }
  return n;
}

/* ── DISPONIBILIDADE PELA JANELA DO CONTRATO · 17/09/2026 ──────────────────────────────────────
 * O anexo de KPI do contrato de O&M mede, por inversor, horas gerando / (horas com irradiancia
 * acima de 100 W/m2 - horas excluidas), e a do parque e a MEDIA SIMPLES dos inversores.
 *
 * 🔴 A JANELA DO CONTADOR NAO SERVE PARA ISTO, e foi MEDIDO: em 38 dias, o contador de operacao
 *    marca 1,7 h a MAIS que a janela de 100 W/m2 (mediana), porque conta o amanhecer e o fim de
 *    tarde abaixo do limiar. Com min(contador, janela) a conta saturava em 100,00 % em 23 dos 38
 *    dias e nao separava inversor nenhum. O que mede e a CURVA de 30 min: conta-se, por inversor,
 *    quantos instantes DENTRO da janela tem potencia positiva.
 *
 * ⚠️ O QUE FALTA PARA SER O NUMERO DO CONTRATO: as HORAS EXCLUIDAS (dez tipos: falha na
 *    transmissao, pedido do contratante, forca maior, falta de peca...). Elas nao estao em fonte
 *    que o pipeline leia, e sem elas a conta e CONSERVADORA — uma parada que o contrato excluiria
 *    entra aqui como indisponibilidade. Por isso o campo leva `sem_exclusoes` no nome.
 *
 * ⚠️ A amostra e INSTANTANEA a cada 30 min: "gerando" e ter potencia positiva no instante, e a
 *    resolucao da medida e meia hora. Parada mais curta que isso nao aparece.
 */
const LIMIAR_IRR = 100;       // W/m2, do anexo do contrato
const MIN_SLOTS_JANELA = 12;  // menos de 6 h de janela num dia: o dia nao serve de base

/** a janela do contrato por (dia, usina): os instantes de 30 min com irradiancia acima do limiar.
 * @param {Array<Object>} serie linhas do irr_30min: { t: 'AAAA-MM-DDTHH:MM:SS-03:00', <ufv>: W/m2 }
 * @param {Array<string>} ufvs colunas de usina a considerar
 * @returns {Map<string, Set<string>>} 'dia|ufv' -> Set('HH:MM') */
function janelaContrato(serie, ufvs) {
  const out = new Map();
  for (const x of serie || []) {
    if (!x || !x.t) continue;
    const dia = String(x.t).slice(0, 10), hm = String(x.t).slice(11, 16);
    for (const u of ufvs || []) {
      const g = x[u];
      if (g == null || !isFinite(g) || g <= LIMIAR_IRR) continue;
      const k = dia + '|' + u;
      if (!out.has(k)) out.set(k, new Set());
      out.get(k).add(hm);
    }
  }
  return out;
}

/** disponibilidade pela janela do contrato, SEM as exclusoes.
 *
 * 🔴 O DENOMINADOR E O LIDO, NAO A JANELA (19/09/2026). Inversor que entra na coleta no meio do dia
 *    — M9/TS1 INV04/05/06/08/10 em 18/09/2026, telemetria a partir das 14:00, com o contador de
 *    operacao marcando o dia INTEIRO — saia a 32 % e derrubava a usina a 85 %: a manha SEM LEITURA
 *    contava como PARADA. Sao coisas distintas: a primeira e falha de coleta, a segunda e o que o
 *    contrato mede. Divide-se por min(lidos, janela); inversor sem leitura nenhuma na janela fica
 *    FORA da media (nao ha o que medir), e os instantes sem leitura vao CONTADOS em `sem_leitura`,
 *    para a tela poder dizer. Registro SEM `lidos` (gravado antes do campo existir) segue com a
 *    janela inteira: nao se reinterpreta o que nao se mediu.
 *
 * @param {Array<{dia:string, ufv:string, ts?:string, inv:string, gerando:number, lidos?:number}>} porInv
 *   um por inversor-dia; `gerando` = instantes de 30 min com potencia positiva DENTRO da janela do
 *   dia; `lidos` = instantes da janela em que o inversor TEM leitura
 * @param {Map<string, Set<string>>} janela de janelaContrato
 * @returns {Map<string, {janela_h:number|null, porUfv:Object, complexo:Object|null}>} por dia; em
 *   porUfv[u]: disp_pct, n, janela_h, piores, sem_leitura (instantes inversor sem leitura na janela)
 *   e fora_sem_leitura (inversores sem leitura nenhuma, que nao entraram na media) */
function dispContrato(porInv, janela) {
  const porDia = new Map();
  for (const l of porInv || []) {
    if (!l || l.gerando == null || !isFinite(l.gerando)) continue;
    const J = janela.get(l.dia + '|' + l.ufv);
    if (!J || J.size < MIN_SLOTS_JANELA) continue;
    if (!porDia.has(l.dia)) porDia.set(l.dia, {});
    const P = porDia.get(l.dia);
    if (!P[l.ufv]) P[l.ufv] = { s: 0, n: 0, slots: J.size, piores: [], semLeitura: 0, foraSemLeitura: 0 };
    const temLidos = l.lidos != null && isFinite(l.lidos);
    const den = temLidos ? Math.min(l.lidos, J.size) : J.size;
    if (temLidos) P[l.ufv].semLeitura += Math.max(0, J.size - l.lidos);
    if (den <= 0) { P[l.ufv].foraSemLeitura++; continue; }
    const f = Math.min(1, l.gerando / den);
    P[l.ufv].s += f; P[l.ufv].n++;
    if (f < PARCIAL) P[l.ufv].piores.push({ inv: (l.ts ? l.ts + '/' : '') + l.inv, pct: r2(100 * f) });
  }
  const out = new Map();
  for (const [dia, P] of porDia) {
    const res = { janela_h: null, porUfv: {}, complexo: null };
    let sCx = 0, nCx = 0; const slots = [];
    for (const [ufv, o] of Object.entries(P)) {
      if (!o.n) continue;   /* usina em que NENHUM inversor teve leitura na janela: nao ha medida a publicar */
      res.porUfv[ufv] = { disp_pct: r2(100 * o.s / o.n), n: o.n, janela_h: r2(o.slots / 2),
        piores: o.piores.sort((a, b) => a.pct - b.pct).slice(0, 3),
        sem_leitura: o.semLeitura, fora_sem_leitura: o.foraSemLeitura };
      sCx += o.s; nCx += o.n; slots.push(o.slots);
    }
    res.janela_h = slots.length ? r2((slots.reduce((a, b) => a + b, 0) / slots.length) / 2) : null;
    res.complexo = nCx ? { disp_pct: r2(100 * sCx / nCx), n: nCx } : null;
    out.set(dia, res);
  }
  return out;
}

module.exports = { disponibilidade, mensal, completaDisponibilidade, janelaContrato, dispContrato,
  LIMITE_DIURNO_MIN, JANELA_MIN, JANELA_MAX, PARADO, PARCIAL, LIMIAR_IRR, MIN_SLOTS_JANELA };
