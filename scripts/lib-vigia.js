'use strict';
/*
 * lib-vigia.js — a RODADA do vigia de resultado e de cadencia (`gen-relogio-watchdog.js`), pura e sem rede: das respostas
 * cruas do GitHub ate quem abre, quem fecha e o estado a gravar. O vigia so le, avisa e grava; o ensaio
 * (`ensaio-vigia-resultado.js`) julga esta regra e executa o vigia com o GitHub forjado (PROMOVER vigia-desmente, 11/10/2026).
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
 *   - ULTIMO SUCESSO: o maior `created_at` com `conclusion` success entre as execucoes da LISTA (ate 100, a mesma chamada
 *     que traz a ultima) e a da consulta FILTRADA. Nenhuma das duas inventa sucesso recente; a filtrada so erra para tras.
 *     Idade presa em zero (a lista e lida depois de `agora`).
 *   - A ULTIMA EXECUCAO e a de maior `created_at` da lista, qualquer que seja a ordem em que ela veio.
 *   - PENDENTE: a ultima execucao nao terminou (qualquer status que nao `completed`: in_progress, queued, waiting…), o
 *     ultimo sucesso esta ALEM do limite, e ela foi criada ha no maximo `limite` min. Nao acende (pode dar certo) e nao
 *     apaga (ainda nao deu). Criada ha MAIS que o limite, ela esta presa (a run em `queued` de 13/09/2026) e conta como
 *     falha: pendente sem prazo deixaria o vigia mudo enquanto houver sempre uma rodada no topo.
 *   - QUEM FECHA: o alarme de resultado so fecha para o workflow julgado saudavel nesta rodada; o de cadencia so para o
 *     workflow LIDO nesta rodada e dentro da cadencia. Nao lido (erro de API, cron que o parser recusa) mantem os dois.
 *   - FORA DA AGENDA: chave de workflow que saiu da agenda fecha as duas familias com aviso proprio e sai do estado.
 *   - Abertos conservam a data de abertura.
 */
const ms = (r) => Date.parse(r.created_at);

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
   agenda: os workflows da agenda; estado: { 'cadencia:<wf>': iso, 'resultado:<wf>': iso } */
function rodada({ agora, agoraIso, agenda, entradas, estado, tolerancia, margem }) {
  const linhas = [], atrasados = [], quebrados = [], saudaveis = [], lidos = [], indecididos = [];
  for (const e of entradas) {
    if (e.erro) { indecididos.push(e.wf + ' (' + e.erro + ')'); continue; }
    if (e.gap == null) { indecididos.push(e.wf); continue; }
    const runs = [...(e.lista || [])].sort((a, b) => ms(b) - ms(a));
    const ult = runs[0];
    if (!ult) { indecididos.push(e.wf + ' (sem execucao registrada)'); continue; }
    lidos.push(e.wf);
    const limite = Math.round(e.gap * tolerancia + margem);
    const idade = Math.max(0, Math.round((agora - ms(ult)) / 60000));
    const ok = idade <= limite;
    const v = veredito(agora, ult, ultimoSucesso(runs, e.filtrado), limite);
    linhas.push({ wf: e.wf, cadencia_min: e.gap, idade_min: idade, limite_min: limite, evento: ult.event,
      conclusao: ult.conclusion, ok: ok ? 1 : 0, idade_sucesso_min: v.idadeOk, saudavel: v.saudavel, pendente: v.pendente });
    if (!ok) atrasados.push({ wf: e.wf, idade, limite, cadencia: e.gap });
    if (v.saudavel === 0) quebrados.push({ wf: e.wf, idade: v.idadeOk, limite, cadencia: e.gap, conclusao: ult.conclusion });
    if (v.saudavel === 1) saudaveis.push(e.wf);
  }
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
  return { linhas, atrasados, quebrados, saudaveis, indecididos, novos, voltaram, novosQ, voltaramQ, sairam, estado: st };
}

module.exports = { ultimoSucesso, veredito, rodada };
