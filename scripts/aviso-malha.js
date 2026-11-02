'use strict';
/*
 * aviso-malha.js — o aviso por e-mail do que a Malha mede e ninguem avisava (lote aviso-malha, 01/11/2026).
 *
 * Auditoria de automacao do SIGO (01/11/2026, item 1): a Malha de Dados e a do Acervo calculam atraso e falha, mas so mostram na tela.
 * Os outros vigias ja avisam o que e deles (a medicao, o relogio dos workflows, o supervisorio, a ponte as 08:40 e 12:40); aqui entra
 * so o que ficava sem aviso. Dois modos, um passo cada no malha-estado.yml:
 *   · (padrao) DADO PUBLICADO fora do prazo: os `frescor[]` com st `fa` ou `sem` (arquivo que o portal le e nao existe ou nao se le
 *     quebra a pagina: o gerador o conta como falha), fora a etapa `way2` (o vigia da medicao e dono). UM evento so, `frescor`, com a
 *     lista no corpo: uma causa (workflow parado, ponte fora) derruba varios arquivos juntos, e um e-mail por arquivo afogaria o canal.
 *     Inclui o dado congelado regravado todo dia, que o vigia do relogio nao pega (o workflow segue verde). O evento aberto guarda os
 *     ids avisados (o JSON que o lib-alerta poe na issue): dado NOVO na lista avisa de novo (comenta e manda o e-mail), senao um dado
 *     parado ha dias calaria todos os que vencessem depois;
 *   · `--vencimentos`: as credenciais a vencer (portal-admin/vencimentos.json), ver decideVencimentos;
 *   · `--so-acervo`: a TAREFA DO ACERVO parada ou com conjunto falhando, lida do estado que ela grava a cada rodada (acervo/estado.json).
 *     Roda na nuvem e num passo proprio, que roda mesmo com o gerador da malha quebrado.
 *
 * Dedup pelo lib-alerta com `soSeNova`: o evento ja aberto nao manda de novo; `resolve` fecha e avisa a normalizacao (sem evento aberto,
 * nenhum canal). `at` (ainda no dobro do prazo) nao avisa. O publicacao do portal NAO entra: o gerador ainda grava `portal` como "sem"
 * fixo (sem registro legivel do deploy); entra quando houver.
 *
 * Janela do Acervo: a tarefa roda de hora em hora das 06h as 22h (Brasilia). Parada = a ultima rodada tem mais de ACERVO_PRAZO_MIN,
 * medido so das 07:15 as 23:00 (a pausa da noite e normal); a fonte do prazo e a agenda da tarefa (2 rodadas + 10 min). A falha de
 * conjunto so FECHA no fim da janela (22:15–23:00) com a ultima rodada limpa: conjunto que alterna falha e ok da no maximo um par por dia.
 *
 * 🔴 CANAL AUSENTE E DEFEITO (como o alerta-must): falta peca do e-mail (AZ_MAIL_*, MAIL_DE, MAIL_PARA) ou o GITHUB_TOKEN (a memoria do
 *    dedup) -> exit 1 antes de julgar. Depois, cada evento novo tem de ter sido ENVIADO ou ja estar aberto; e-mail '-' ou FALHOU, ou
 *    issue FALHOU, derrubam a rodada. SECO=1 (so na maquina) julga e imprime sem canal nenhum.
 * 🔴 TEXTO PUBLICO: titulo e corpo viram issue num repositorio publico. Nada de conta, conteiner, arquivo, caminho, maquina ou erro da
 *    tarefa; do Acervo sai so a contagem de falhas. O ensaio confere.
 *
 * Env: MALHA_JSON / ACERVO_JSON (arquivos locais, para ensaiar) ou a credencial do job (OIDC); AGORA (ISO, so ensaio); SECO=1;
 *      os do lib-alerta (GITHUB_TOKEN, AZ_MAIL_TENANT_ID, AZ_MAIL_CLIENT_ID, MAIL_DE, MAIL_PARA).
 */
const fs = require('fs');
const zlib = require('zlib');

const ACERVO_PRAZO_MIN = 130;
const ACERVO_JANELA = [7 * 60 + 15, 23 * 60];          // minutos do dia em Brasilia
const ACERVO_FECHA = [22 * 60 + 15, 23 * 60];          // a falha de conjunto so fecha aqui
const ETAPA_DE_OUTRO = ['way2'];                       // o vigia da medicao avisa
const BRT_MS = 3 * 3600000;
const T_FRESCOR = 'dado publicado fora do prazo';
const T_PARADA = 'tarefa do Acervo sem rodar';
const T_FALHA = 'tarefa do Acervo com conjunto falhando';

const minBRT = (ms) => { const d = new Date(ms - BRT_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hBRT = (ms) => new Date(ms - BRT_MS).toISOString().slice(0, 16).replace('T', ' ');
const fmtMin = (m) => (m >= 120 ? String(Math.round(m / 6) / 10).replace('.', ',') + ' h' : m + ' min');

/* O dado publicado: um evento so. */
function decideMalha(malha) {
  if (!malha || !Array.isArray(malha.frescor)) throw new Error('estado da malha sem a lista de frescor');
  const ruins = malha.frescor.filter((f) => (f.st === 'fa' || f.st === 'sem') && ETAPA_DE_OUTRO.indexOf(f.etapa) < 0);
  if (!ruins.length) return [{ tipo: 'malha_frescor', chave: 'frescor', titulo: T_FRESCOR, resolve: true,
    assunto: '✅ Mauriti · os dados publicados voltaram ao prazo', corpo: 'Todos os dados publicados que o portal le estao no prazo de novo.' }];
  const linha = (f) => '<li><b>' + f.id + '</b>: ' + (f.st === 'sem' ? 'ausente ou ilegivel' : 'idade ' + fmtMin(f.idade_min) + ', prazo ' + fmtMin(f.prazo_min)
    + (f.medida === 'conteudo' ? ', medida pelo fim do dado' + (f.ate ? ' (ate ' + f.ate + ' UTC)' : '') : ', medida pela gravacao')) + '</li>';
  return [{ tipo: 'malha_frescor', chave: 'frescor', titulo: T_FRESCOR, soSeNova: true, ids: ruins.map((f) => f.id),
    assunto: '🔴 Mauriti · ' + ruins.length + (ruins.length === 1 ? ' dado publicado fora do prazo' : ' dados publicados fora do prazo'),
    corpo: '<b>' + (ruins.length === 1 ? 'Um dado que o portal le esta' : ruins.length + ' dados que o portal le estao') + ' fora do prazo.</b><br><br>'
      + '<ul>' + ruins.map(linha).join('') + '</ul>'
      + 'Varios juntos costumam ter uma causa so (um workflow parado ou a ponte fora). O detalhe esta na Malha de Dados do Portal Corporativo.' }];
}

/* A tarefa do Acervo: parada e falha, cada uma com a sua chave. `acervo` null = sem registro (404). */
function decideAcervo(acervo, agoraMs) {
  const A = [];
  const q = acervo ? Date.parse(String(acervo.quando || '') + '-03:00') : NaN;   // a tarefa grava a hora de Brasilia, sem fuso
  const m = minBRT(agoraMs);
  const naJanela = m >= ACERVO_JANELA[0] && m <= ACERVO_JANELA[1];
  const idade = isFinite(q) ? Math.round((agoraMs - q) / 60000) : null;
  if (naJanela && (idade === null || idade > ACERVO_PRAZO_MIN)) A.push({ tipo: 'acervo_parada', chave: 'acervo:parada', titulo: T_PARADA, soSeNova: true,
    assunto: '🔴 Mauriti · o Acervo parou de se atualizar',
    corpo: '<b>A atualizacao automatica do Acervo nao roda ' + (idade === null ? '(sem registro da ultima rodada)' : 'ha ' + fmtMin(idade)) + '.</b><br><br>'
      + 'Ela roda de hora em hora, das 06h as 22h' + (isFinite(q) ? '; a ultima foi em ' + hBRT(q) + ' (Brasilia)' : '') + '.'
      + '<br>O que ja estava publicado continua no ar. O detalhe esta na Malha do Acervo.' });
  else if (idade !== null && idade <= ACERVO_PRAZO_MIN) A.push({ tipo: 'acervo_parada', chave: 'acervo:parada', titulo: T_PARADA, resolve: true,
    assunto: '✅ Mauriti · o Acervo voltou a se atualizar', corpo: 'A atualizacao automatica do Acervo voltou a rodar (' + hBRT(q) + ', Brasilia).' });
  if (acervo && acervo.falhas > 0) A.push({ tipo: 'acervo_falha', chave: 'acervo:falha', titulo: T_FALHA, soSeNova: true,
    assunto: '🟠 Mauriti · ' + acervo.falhas + (acervo.falhas === 1 ? ' conjunto do Acervo falhou' : ' conjuntos do Acervo falharam'),
    corpo: '<b>Na rodada de ' + hBRT(q) + ' (Brasilia), ' + acervo.falhas + (acervo.falhas === 1 ? ' conjunto do Acervo nao foi atualizado' : ' conjuntos do Acervo nao foram atualizados') + '.</b>'
      + '<br><br>O que ja estava publicado continua no ar. O detalhe esta na Malha do Acervo.' });
  else if (acervo && acervo.falhas === 0 && m >= ACERVO_FECHA[0] && m <= ACERVO_FECHA[1]) A.push({ tipo: 'acervo_falha', chave: 'acervo:falha', titulo: T_FALHA, resolve: true,
    assunto: '✅ Mauriti · o Acervo voltou a atualizar todos os conjuntos', corpo: 'Na ultima rodada do dia, todos os conjuntos do Acervo foram atualizados.' });
  return A;
}

/* Os ids ja avisados no evento aberto: o ULTIMO `"ids":[...]` do corpo e dos comentarios da issue (o lib-alerta grava os campos do evento). */
function idsDoTexto(textos) {
  let ult = null;
  for (const x of textos) { const re = /"ids":(\[[^\]]*\])/g; let m; while ((m = re.exec(String(x || '')))) { try { ult = JSON.parse(m[1]); } catch (e) { /* segue */ } } }
  return ult;
}
/* O evento que traz dado novo deixa de ser `soSeNova`: o lib-alerta comenta na issue aberta e manda o e-mail. */
function marcaNovos(a, avisados) {
  if (!a.soSeNova || !a.ids || !avisados) return a;
  const novos = a.ids.filter((id) => avisados.indexOf(id) < 0);
  if (!novos.length) return a;
  return Object.assign({}, a, { soSeNova: false, assunto: a.assunto + ' · novo: ' + novos.join(', ') });
}
function gh(caminho) {
  const https = require('https');
  const repo = process.env.GH_REPO || 'rbenergyoficial/dashboard-powerchina', tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  return new Promise((ok, ko) => {
    const r = https.request({ host: 'api.github.com', path: '/repos/' + repo + caminho, method: 'GET', family: 4, timeout: 20000,
      headers: { 'User-Agent': 'aviso-malha', Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } }, (x) => {
      const b = []; x.on('data', (c) => b.push(c));
      x.on('end', () => { const s = Buffer.concat(b).toString(); if (x.statusCode >= 300) return ko(new Error('GitHub HTTP ' + x.statusCode)); ok(JSON.parse(s)); });
    });
    r.on('timeout', () => r.destroy(new Error('GitHub sem resposta'))); r.on('error', ko); r.end();
  });
}
/* null = nenhum evento aberto. Falha de consulta ESTOURA (a rodada fica vermelha): avisar de novo ou calar, nenhum dos dois em silencio. */
async function idsAvisados(titulo) {
  for (let p = 1; p <= 10; p++) {
    const v = await gh('/issues?state=open&labels=' + encodeURIComponent(process.env.ALERTA_ROTULO || 'alerta-automatico') + '&per_page=100&page=' + p);
    const i = v.find((x) => x.title === titulo);
    if (i) {
      const cs = i.comments ? await gh('/issues/' + i.number + '/comments?per_page=100&page=' + Math.max(1, Math.ceil(i.comments / 100))) : [];
      return idsDoTexto([i.body].concat(cs.map((c) => c.body)));
    }
    if (v.length < 100) return null;
  }
  return null;
}

/* Os vencimentos (aviso-vencimentos, 02/11/2026): o arquivo que a tarefa do Acervo grava uma vez por dia (vigia-vencimentos, da Auditoria
 * de dados). Um evento por item E por limiar E pela data de vencimento: o 60, o 30, o 7 (so os criticos, o vigia decide) e o vencido avisam
 * uma vez cada; a renovacao muda a data e o ciclo recomeca. A issue (publica) leva so o tipo, o dono, a data e os dias, com uma referencia
 * curta (os 8 primeiros do sha1 do nome); o nome do item, que traz conta e conteiner, vai so no `corpoEmail`. Arquivo velho (mais de 3 dias)
 * avisa que o vigia parou. */
const VENC_TIPO = { sas_politica: 'credencial de acesso a dados', chave_conta: 'chave da conta de armazenamento', segredo_app: 'segredo de aplicativo',
  token: 'token de acesso', certificado: 'certificado', senha: 'senha' };
const VENC_NIVEL = ['60', '30', '7', 'vencido'];
const VENC_VELHO_MS = 3 * 86400000;
const dataBR = (d) => String(d).slice(8, 10) + '/' + String(d).slice(5, 7) + '/' + String(d).slice(0, 4);
function decideVencimentos(v, agoraMs) {
  if (!v || !Array.isArray(v.itens)) throw new Error('arquivo de vencimentos sem a lista de itens');
  const A = [];
  const g = Date.parse(v.gerado);
  const velho = !isFinite(g) || agoraMs - g > VENC_VELHO_MS;
  A.push(velho
    ? { tipo: 'vencimento_vigia', chave: 'vencimento:vigia', titulo: 'vigia de vencimentos parado', soSeNova: true,
      assunto: '🟠 Mauriti · a lista de vencimentos nao se atualiza', corpo: '<b>A lista de vencimentos das credenciais nao e atualizada ha mais de 3 dias.</b>'
        + '<br><br>Ela e refeita uma vez por dia pela atualizacao automatica do Acervo. Enquanto isso, nenhum vencimento novo e avisado.' }
    : { tipo: 'vencimento_vigia', chave: 'vencimento:vigia', titulo: 'vigia de vencimentos parado', resolve: true,
      assunto: '✅ Mauriti · a lista de vencimentos voltou a se atualizar', corpo: 'A lista de vencimentos das credenciais voltou a ser atualizada.' });
  const crypto = require('crypto');
  for (const x of v.itens) {
    if (VENC_NIVEL.indexOf(String(x.alerta)) < 0) continue;
    const ref = crypto.createHash('sha1').update(String(x.item)).digest('hex').slice(0, 8);
    const tipo = VENC_TIPO[x.tipo] || 'credencial';
    const quando = x.alerta === 'vencido' ? 'VENCEU em ' + dataBR(x.vence) : 'vence em ' + dataBR(x.vence) + ' (' + x.dias_restantes + ' dias)';
    A.push({ tipo: 'vencimento', chave: 'vencimento:' + ref + ':' + x.vence + ':' + x.alerta, titulo: tipo + ' a vencer (' + ref + ', ' + x.alerta + ')', soSeNova: true,
      assunto: (x.alerta === 'vencido' || x.alerta === '7' ? '🔴' : '🟠') + ' Mauriti · ' + tipo + ' ' + quando,
      corpo: '<b>Uma ' + tipo + (x.critico ? ' critica' : '') + ' ' + quando + '.</b><br><br>Referencia ' + ref + ' · responsavel: ' + x.dono + '.'
        + '<br>O nome esta no e-mail enviado ao responsavel e na lista de vencimentos da area do administrador.',
      corpoEmail: '<b>' + x.item + '</b> ' + quando + (x.critico ? ' (critica)' : '') + '.<br><br>Responsavel: ' + x.dono + '.<br>De onde vem a data: ' + x.fonte
        + '.<br>Referencia ' + ref + '.' });
  }
  return A;
}

function leLocal(arq) { const b = fs.readFileSync(arq); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8')); }

async function leMalha() {
  if (process.env.MALHA_JSON) return leLocal(process.env.MALHA_JSON);
  const LC = require('./lib-conteiner');
  if (!LC.credencial()) throw new Error('sem credencial para ler o estado da malha');
  const r = await LC.conteiner('portal-admin').getBlobClient('malha_estado.json').download();   // o papel do job: so este arquivo
  const p = []; for await (const c of r.readableStreamBody) p.push(c);
  const b = Buffer.concat(p);
  return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8'));
}
async function leAcervo() {
  if (process.env.ACERVO_JSON) return leLocal(process.env.ACERVO_JSON);
  const LD = require('./lib-le-dados');
  return LD.json(LD.BASE + 'acervo/estado.json');   // null = 404: sem registro, avisa como parada (na janela)
}

async function leVencimentos() {
  if (process.env.VENC_JSON) return leLocal(process.env.VENC_JSON);
  const LC = require('./lib-conteiner');
  if (!LC.credencial()) throw new Error('sem credencial para ler os vencimentos');
  const r = await LC.conteiner('portal-admin').getBlobClient('vencimentos.json').download();   // o papel do job: so leitura deste nome
  const p = []; for await (const c of r.readableStreamBody) p.push(c);
  const b = Buffer.concat(p);
  return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8'));
}

async function main() {
  const soAcervo = process.argv.indexOf('--so-acervo') > 0, soVenc = process.argv.indexOf('--vencimentos') > 0;
  const agoraMs = process.env.AGORA ? Date.parse(process.env.AGORA) : Date.now();
  if (!isFinite(agoraMs)) throw new Error('AGORA ilegivel');
  const seco = process.env.SECO === '1';
  const falta = ['GITHUB_TOKEN', 'AZ_MAIL_TENANT_ID', 'AZ_MAIL_CLIENT_ID', 'MAIL_DE', 'MAIL_PARA'].filter((k) => !String(process.env[k] || '').trim());
  if (!seco && falta.length) { console.error('::error::aviso-malha: canal incompleto, falta ' + falta.join(', ') + ' — nada julgado'); return 1; }
  let acoes = soVenc ? decideVencimentos(await leVencimentos(), agoraMs) : soAcervo ? decideAcervo(await leAcervo(), agoraMs) : decideMalha(await leMalha());
  if (seco) { for (const a of acoes) console.log((a.resolve ? 'fecha ' : 'AVISA ') + a.chave + ' · ' + a.assunto); return 0; }
  const { alerta, tituloDe } = require('./lib-alerta');
  const v = [];
  for (const a of acoes) v.push(a.ids ? marcaNovos(a, await idsAvisados(tituloDe(a))) : a);
  acoes = v;
  let falhou = 0, n = 0;
  for (const a of acoes) {
    const out = await alerta(a);
    if (a.resolve) { if (/^FALHOU/.test(out.issue || '')) { falhou++; console.error('::error::aviso-malha: ' + a.chave + ' · issue: ' + out.issue); } continue; }
    n++;
    const chegou = /^enviado/.test(out.email || '') || /^ja aberta #\d/.test(out.issue || '');
    if (!chegou || /^FALHOU/.test(out.issue || '')) { falhou++; console.error('::error::aviso-malha: ' + a.chave + ' · email: ' + out.email + ' · issue: ' + out.issue); }
  }
  console.log('aviso-malha' + (soVenc ? ' (vencimentos)' : soAcervo ? ' (acervo)' : '') + ': ' + n + ' evento(s) julgado(s) em aberto, ' + (acoes.length - n) + ' normalizacao(oes) conferida(s)');
  return falhou ? 1 : 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('ERRO: ' + (e && e.message ? e.message : e)); process.exit(1); });
else module.exports = { decideMalha, decideAcervo, decideVencimentos, idsDoTexto, marcaNovos, ACERVO_PRAZO_MIN, ACERVO_JANELA, ACERVO_FECHA };
