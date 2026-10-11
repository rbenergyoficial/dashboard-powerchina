'use strict';
/*
 * lib-vigia.js — a RODADA do vigia de resultado e de cadencia (`gen-relogio-watchdog.js`), pura e sem rede: das respostas
 * cruas do GitHub ate quem abre, quem fecha, o estado a gravar e a saude a publicar. O vigia so le, avisa e grava; o
 * ensaio (`ensaio-vigia-resultado.js`) julga esta regra e executa o vigia com o GitHub forjado (PROMOVER vigia-desmente,
 * 11/10/2026; acompanhamento vigia-desmente-2).
 *
 * 🔴 O VIGIA QUE SE DESMENTIA (06 a 10/10/2026). O `executivo.yml` ficou sem sucesso por quatro dias, e o vigia mandou
 * doze e-mails alternando 🔴 e ✅, abriu e fechou issue tres vezes. Dois defeitos, medidos nos logs e nas issues:
 *   1. EXECUCAO EM ANDAMENTO FECHAVA O ALARME. `saudavel = idadeOk <= limite || rodando`: a rodada que acabou de comecar
 *      contava como saudavel e fechava a issue com um ✅ falso. A #337 foi fechada as 23:43:42Z de 08/10 pela run comecada
 *      as 23:43:25Z, que falhou; a #402, as 17:13:20Z de 09/10, igual. Cada fechamento falso gerava issue NOVA e outro 🔴.
 *   2. A CONSULTA FILTRADA DEVOLVIA SUCESSO VELHO. `runs?status=success&per_page=1` deu "sem sucesso ha 20.584 min" (14
 *      dias) e "32.477 min" (22 dias) em 07/10, com o ultimo sucesso real a 9–15 h. Intermitente, do lado do GitHub.
 *
 * AS REGRAS
 *   - O INSTANTE de uma execucao e o inicio da tentativa (`run_started_at`), e na falta dele o `created_at`: um "Re-run"
 *     guarda o `created_at` da rodada original, e contaria como sucesso velho (ou como rodada presa).
 *   - ULTIMO SUCESSO: o de maior instante com `conclusion` success entre as execucoes da LISTA (ate 100, a mesma chamada que
 *     traz a ultima) e a da consulta FILTRADA. Nenhuma das duas inventa sucesso recente; a filtrada so erra para tras.
 *     Idades presas em zero (a lista e lida depois de `agora`).
 *   - A ULTIMA EXECUCAO e a de maior instante da lista. Lista vazia nao e leitura: o workflow fica sem julgamento.
 *   - PENDENTE: a ultima execucao nao terminou (qualquer status que nao `completed`), o ultimo sucesso esta ALEM do limite,
 *     e ela comecou ha no maximo `limite` min: nao acende (pode dar certo) e nao apaga (ainda nao deu). Alem disso esta
 *     presa (a run em `queued` de 13/09/2026) e conta como falha.
 *   - QUEM FECHA: o alarme de resultado so fecha para o workflow julgado saudavel nesta rodada; o de cadencia so para o
 *     workflow LIDO nesta rodada e dentro da cadencia. Nao lido mantem os dois. Abertos conservam a data de abertura, e
 *     um aberto que continua aberto nao avisa de novo.
 *   - FORA DA AGENDA: chave de workflow que saiu da agenda fecha as duas familias com aviso proprio e sai do estado.
 *   - A CADENCIA pergunta se o relogio esta disparando, e quem dispara CRIA a execucao: a idade da cadencia e a da
 *     execucao de maior `created_at`. Um Re-run manual nao cria nada e nao pode esconder um relogio parado. (Em 3.318
 *     execucoes reais de 04 a 11/10/2026, `run_started_at` = `created_at` em todas: os dois so diferem num re-run.)
 *   - ESTADO ILEGIVEL (o blob existe e nao se le, ou nao e um objeto de chaves e datas): sem ele o vigia nao sabe o que
 *     esta aberto. Nada se decide por workflow e nada se grava no estado; a saude sai assim mesmo, com `estado_legivel` 0,
 *     e o aviso proprio (`vigia:estado`) e pedido em TODA rodada ilegivel, com `soSeNova`: o dedup e a issue aberta, que
 *     nao depende do storage nem da ordem dos passos. Na rodada legivel, o aviso e fechado (sem issue aberta, nada sai).
 *     Antes deste acompanhamento o vigia parava antes de ler o GitHub e ficava mudo (revisor-ensaio, RE-014 a RE-023).
 *   - FRESCOR DO DADO (`frescor:<blob>`, PROMOVER vigia-frescor, 11/10/2026): as duas familias julgam o WORKFLOW; esta julga
 *     o DADO, pela ancora que so a rodada completa grava (`executivo.json` -> `atualizado`). De 08 a 10/10 o executivo ficou
 *     sem gravar a rodada completa e o selo "ao vivo ate" seguia fresco, porque o remendo de 5 min o move; e um job VERDE
 *     que nao grava nao acende nada nas outras familias. O limite e o mesmo da cadencia do workflow que grava o blob (o
 *     maior vao do cron x tolerancia + margem). Abre com a ancora alem do limite, fecha com ela de volta; nao lido mantem.
 *     O blob LIDO sem a ancora valida (campo ausente ou que nao e data) e CONTRATO QUEBRADO, nao "nao lido": conta como
 *     velho, com o motivo, e a saude diz `fresco: null` — senao uma mudanca no gerador calaria a familia para sempre e a
 *     saude diria "dado fresco" por omissao. Chave de blob que saiu da lista FRESCOR fecha com aviso proprio e sai do
 *     estado. LIMITES DECLARADOS: (1) o limite vem do MAIOR vao do cron (22:13 a 04:13 no executivo: 920 min), entao
 *     de dia a parada so e notada depois de ~15 h; (2) o `atualizado` mede a RODADA, nao a completude dos dias: uma
 *     guarda que retenha dias em vez de abortar a rodada deixa a ancora andar com os dias parados.
 */
const ms = (r) => Date.parse(r.run_started_at || r.created_at);
const cri = (r) => Date.parse(r.created_at);

/* o estado so vale como objeto simples de 'familia:<wf>' -> data: `null`, lista ou numero gravados por cima seriam lidos
   como "nada aberto" (ou derrubariam a rodada seguinte) */
function estadoValido(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x)
    && Object.entries(x).every(([k, v]) => /^(cadencia|resultado|frescor):.+/.test(k) && typeof v === 'string');
}

function ultimoSucesso(runs, filtrado) {
  let melhor = null;
  for (const r of [...(runs || []), ...(filtrado ? [filtrado] : [])]) {
    if (!r || r.conclusion !== 'success') continue;
    if (!melhor || ms(r) > ms(melhor)) melhor = r;
  }
  return melhor;
}

function veredito(agora, ult, suc, limite) {
  const idadeOk = suc ? Math.max(0, Math.round((agora - ms(suc)) / 60000)) : null;
  const rodando = ult.conclusion === null || ult.status !== 'completed';
  const idadeUlt = Math.max(0, Math.round((agora - ms(ult)) / 60000));
  if (idadeOk === null) return { idadeOk, rodando, saudavel: null, pendente: 0 };
  if (idadeOk <= limite) return { idadeOk, rodando, saudavel: 1, pendente: 0 };
  if (rodando && idadeUlt <= limite) return { idadeOk, rodando, saudavel: null, pendente: 1 };
  return { idadeOk, rodando, saudavel: 0, pendente: 0 };
}

/* uma rodada inteira.
   entradas: [{ wf, gap (min, ou null se o cron foi recusado), lista (runs da chamada per_page=100), filtrado (run ou null),
               erro (texto, se a leitura falhou) }]
   agenda: os workflows da agenda; estado: { 'cadencia:<wf>': iso, 'resultado:<wf>': iso }
   estadoLegivel: false quando o blob de estado existe e nao se le (ou nao e valido)
   frescor: [{ blob, campo, wf, ancoraMs (ou null), erro }] — o dado que so a rodada completa do `wf` grava */
function rodada({ agora, agoraIso, agenda, entradas, estado, tolerancia, margem, estadoLegivel = true, frescor = [] }) {
  const linhas = [], atrasados = [], quebrados = [], saudaveis = [], lidos = [], indecididos = [];
  for (const e of entradas) {
    if (e.erro) { indecididos.push(e.wf + ' (' + e.erro + ')'); continue; }
    if (e.gap == null) { indecididos.push(e.wf); continue; }
    const runs = [...(e.lista || [])].sort((a, b) => ms(b) - ms(a));
    const ult = runs[0];
    if (!ult) { indecididos.push(e.wf + ' (sem execucao registrada)'); continue; }
    lidos.push(e.wf);
    const limite = Math.round(e.gap * tolerancia + margem);
    const criada = runs.reduce((a, r) => (cri(r) > cri(a) ? r : a), runs[0]);
    const idade = Math.max(0, Math.round((agora - cri(criada)) / 60000));
    const ok = idade <= limite;
    const v = veredito(agora, ult, ultimoSucesso(runs, e.filtrado), limite);
    linhas.push({ wf: e.wf, cadencia_min: e.gap, idade_min: idade, limite_min: limite, evento: ult.event,
      conclusao: ult.conclusion, ok: ok ? 1 : 0, idade_sucesso_min: v.idadeOk, saudavel: v.saudavel, pendente: v.pendente });
    if (!ok) atrasados.push({ wf: e.wf, idade, limite, cadencia: e.gap });
    if (v.saudavel === 0) quebrados.push({ wf: e.wf, idade: v.idadeOk, limite, cadencia: e.gap, conclusao: ult.conclusion });
    if (v.saudavel === 1) saudaveis.push(e.wf);
  }
  linhas.sort((a, b) => (b.idade_min / b.limite_min) - (a.idade_min / a.limite_min));
  // o FRESCOR do dado: idade da ancora contra o limite da cadencia do workflow que o grava
  const frescos = [], velhos = [], frescorLinhas = [];
  for (const fr of frescor) {
    const e = entradas.find((x) => x.wf === fr.wf);
    if (fr.erro) { indecididos.push('frescor ' + fr.blob + ' (' + fr.erro + ')'); continue; }
    if (!e || e.gap == null) { indecididos.push('frescor ' + fr.blob + ' (sem a cadencia de ' + fr.wf + ')'); continue; }
    const limite = Math.round(e.gap * tolerancia + margem);
    // o blob foi LIDO e nao traz a ancora valida: contrato quebrado, conta como velho com o motivo
    if (fr.ancoraMs == null || !Number.isFinite(fr.ancoraMs)) {
      const motivo = fr.campo + (fr.ancoraMs == null ? ' ausente no blob' : ' no blob nao e data');
      frescorLinhas.push({ blob: fr.blob, campo: fr.campo, wf: fr.wf, ancora: null, idade_min: null, limite_min: limite, fresco: null, motivo });
      velhos.push({ blob: fr.blob, campo: fr.campo, wf: fr.wf, idade: null, limite, motivo }); continue;
    }
    const idade = Math.max(0, Math.round((agora - fr.ancoraMs) / 60000));
    const fresco = idade <= limite;
    frescorLinhas.push({ blob: fr.blob, campo: fr.campo, wf: fr.wf, ancora: new Date(fr.ancoraMs).toISOString(), idade_min: idade, limite_min: limite, fresco: fresco ? 1 : 0 });
    (fresco ? frescos : velhos).push({ blob: fr.blob, campo: fr.campo, wf: fr.wf, idade, limite });
  }
  const saude = { gerado_em: agoraIso, tolerancia, margem_min: margem, estado_legivel: estadoLegivel ? 1 : 0,
    atrasados: atrasados.length, sem_sucesso: quebrados.length, dado_velho: velhos.length, workflows: linhas, frescor: frescorLinhas };
  const avisoEstado = estadoLegivel ? 'fecha' : 'abre';
  const nada = { novos: [], voltaram: [], novosQ: [], voltaramQ: [], sairam: [], novosF: [], voltaramF: [], sairamF: [] };
  if (!estadoLegivel) return Object.assign({ linhas, atrasados, quebrados, saudaveis, indecididos, velhos, saude, avisoEstado, estado: null }, nada);

  const naAgenda = new Set(agenda);
  const tem = (lista, w) => lista.some((a) => (a.wf || a) === w);
  const chaves = (p) => Object.keys(estado).filter((k) => k.indexOf(p) === 0).map((k) => k.slice(p.length));
  const sairam = [...new Set([...chaves('cadencia:'), ...chaves('resultado:')].filter((w) => !naAgenda.has(w)))];
  const novos = atrasados.filter((a) => !estado['cadencia:' + a.wf]);
  const voltaram = chaves('cadencia:').filter((w) => naAgenda.has(w) && tem(lidos, w) && !tem(atrasados, w));
  const novosQ = quebrados.filter((a) => !estado['resultado:' + a.wf]);
  const voltaramQ = chaves('resultado:').filter((w) => naAgenda.has(w) && tem(saudaveis, w));
  const st = {};
  atrasados.forEach((a) => { const k = 'cadencia:' + a.wf; st[k] = estado[k] || agoraIso; });
  quebrados.forEach((a) => { const k = 'resultado:' + a.wf; st[k] = estado[k] || agoraIso; });
  // o que nao foi decidido nesta rodada fica como estava: cadencia de quem nao foi lido, resultado pendente ou sem veredito
  chaves('cadencia:').filter((w) => naAgenda.has(w) && !tem(lidos, w)).forEach((w) => { st['cadencia:' + w] = estado['cadencia:' + w]; });
  chaves('resultado:').filter((w) => naAgenda.has(w) && !tem(quebrados, w) && !tem(saudaveis, w)).forEach((w) => { st['resultado:' + w] = estado['resultado:' + w]; });
  // frescor: abre o velho que nao estava aberto, fecha o aberto que voltou a fresco; o nao lido (ou que saiu da lista) fica
  const temB = (lista, b) => lista.some((x) => x.blob === b);
  const naLista = new Set(frescor.map((x) => x.blob));
  const sairamF = chaves('frescor:').filter((b) => !naLista.has(b));
  const novosF = velhos.filter((v) => !estado['frescor:' + v.blob]);
  const voltaramF = chaves('frescor:').filter((b) => temB(frescos, b));
  velhos.forEach((v) => { const k = 'frescor:' + v.blob; st[k] = estado[k] || agoraIso; });
  chaves('frescor:').filter((b) => naLista.has(b) && !temB(frescos, b) && !temB(velhos, b)).forEach((b) => { st['frescor:' + b] = estado['frescor:' + b]; });
  return { linhas, atrasados, quebrados, saudaveis, indecididos, velhos, saude, avisoEstado, novos, voltaram, novosQ, voltaramQ, sairam, novosF, voltaramF, sairamF, estado: st };
}

module.exports = { ultimoSucesso, veredito, rodada, estadoValido };
