/*
 * ensaio-manchete-remendo.js — o remendo de 5 min move a manchete INTEIRA, e coerente.
 *
 * POR QUE EXISTE. `liq_gwh`, `atingido`, `liq_proj`, `falta_gwh` e os ritmos sao um retrato de uma
 * rodada: avancar um sozinho cria divergencia nova — o defeito que o remendo veio consertar, com o
 * sinal trocado. Este ensaio cobra que eles andem JUNTOS, e que o que nao deve andar fique parado.
 *
 * 🔴 A ASSERCAO QUE IMPORTA E A DA PROJECAO. `liq_proj` parte dos dias FECHADOS, entao a energia de
 * hoje crescendo NAO pode move-la. Se mover, o remendo esta somando o dia em curso na base da
 * projecao — e o card anunciaria o fechamento do mes subindo a cada cinco minutos.
 *
 * Roda sobre a manchete PUBLICADA, com a energia de hoje forjada: o blob da a forma real das linhas
 * (12 entidades, os campos que existem), e o forjado da o controle sobre o que muda.
 *
 * Sem segredo nenhum: le so blob publico.
 */
const https = require('https'), zlib = require('zlib');
const { remendaManchete, parse } = require('./lib-manchete.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

function getJSON(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

const clone = o => JSON.parse(JSON.stringify(o));
const PARADOS = ['dias_decorridos', 'dias_total', 'dias_restantes', 'meta_gwh', 'lbl', 'escopo',
  'spark_liq', 'spark_meta', 'spark_n'];

(async () => {
  const exec = await getJSON(BASE + 'executivo.json');
  const mes = exec.mes_atual;
  const orig = (exec.manchete_ufv || []).filter(x => x.mes === mes && x.fechado === 0);
  const fechadas = (exec.manchete_ufv || []).filter(x => x.fechado === 1);
  const f = [];
  if (!orig.length) {
    console.error('REPROVADO: o blob nao tem manchete de mes em curso — nada a julgar');
    process.exit(1);
  }
  let temAncora = orig.filter(x => x.liq_fechada_gwh != null).length;
  console.log('   manchete de ' + mes + ': ' + orig.length + ' entidades · '
    + temAncora + ' com a ancora `liq_fechada_gwh`');

  /* 🔴 SEM ANCORA O ENSAIO PASSARIA JULGANDO NADA. Enquanto a rodada completa com o executivo novo
     nao publicar `liq_fechada_gwh`, todas as linhas caem no ramo "so a hora" e as asserções de
     ENERGIA — que sao o que este ensaio existe para fazer — nao rodam. Passar ali seria o "tudo
     passou" sobre zero pontos que esta casa ja pagou. Entao a ancora e FORJADA com a mesma conta
     que o executivo publica (`liq - hoje`), e o ensaio diz em que modo rodou. */
  if (temAncora === 0) {
    orig.forEach(m => {
      const liq = parse(m.liq_gwh), hoje = parse(m.hoje_gwh);
      if (liq == null || hoje == null) return;
      m.liq_fechada_gwh = (Math.round((liq - hoje) * 100) / 100).toFixed(2);
    });
    temAncora = orig.filter(x => x.liq_fechada_gwh != null).length;
    console.log('   ⚠️ nenhuma linha publicada traz a ancora ainda (o executivo novo nao rodou) —'
      + ' forjada em ' + temAncora + ', com a mesma conta que ele publica');
  }
  if (temAncora === 0) {
    console.error('REPROVADO: sem ancora nem forjavel, o caminho da ENERGIA nao seria julgado');
    process.exit(1);
  }

  // energia de hoje FORJADA: meia hora a mais que a publicada, por entidade
  const hojePub = {}, gwh = {};
  orig.forEach(m => { hojePub[m.ufv] = parse(m.hoje_gwh) || 0; gwh[m.ufv] = hojePub[m.ufv] + 0.25; });

  const linhas = clone(exec.manchete_ufv.map(m => {
    const o = orig.find(x => x.ufv === m.ufv && x.mes === m.mes);
    return o || m;   // leva a ancora forjada, quando foi o caso
  }));
  const c = remendaManchete(linhas, { mes, diaNum: 28, ate: '14:05', gwhPorUfv: gwh });
  console.log('   remendo: ' + c.quando + ' com a hora, ' + c.energia + ' com a energia'
    + (c.semAncora ? ', ' + c.semAncora + ' sem ancora' : ''));
  if (c.quando !== orig.length) f.push('a hora nao alcancou as ' + orig.length + ' entidades: ' + c.quando);
  /* e a guarda que faltava: o caminho da ENERGIA tem de ter sido percorrido */
  if (c.energia !== temAncora) {
    f.push('a energia entrou em ' + c.energia + ' linhas, e ' + temAncora + ' tinham ancora — '
      + 'sem isso as asserções abaixo passariam por vacuidade');
  }

  const novo = {}; linhas.forEach(m => { novo[m.ufv + '|' + m.mes] = m; });
  orig.forEach(a => {
    const b = novo[a.ufv + '|' + a.mes], id = a.ufv + ' ' + a.mes;
    if (b.dia_hoje !== 28 || b.ao_vivo !== 1 || b.ao_vivo_ate !== '14:05') {
      f.push(id + ': os campos de QUANDO nao entraram');
    }
    if (a.liq_fechada_gwh == null) {   // sem ancora: SO a hora podia mudar
      const mudou = Object.keys(a).filter(k => a[k] !== b[k]
        && !['dia_hoje', 'ao_vivo', 'ao_vivo_ate'].includes(k));
      if (mudou.length) f.push(id + ': sem ancora, mas mexeu em ' + mudou);
      return;
    }
    const base = parse(a.liq_fechada_gwh), meta = parse(a.meta_gwh);
    // 1) a energia anda, e fecha com a ancora
    if (Math.abs(parse(b.hoje_gwh) - gwh[a.ufv]) > 0.011) f.push(id + ': hoje_gwh nao seguiu');
    if (Math.abs(parse(b.liq_gwh) - (base + gwh[a.ufv])) > 0.011) {
      f.push(id + ': liq_gwh nao e liq_fechada + hoje');
    }
    // 2) 🔴 a PROJECAO nao pode andar: ela parte dos dias fechados
    if (a.liq_proj !== b.liq_proj) {
      f.push(id + ': liq_proj MOVEU com a energia de hoje (' + a.liq_proj + ' -> ' + b.liq_proj
        + ') — o dia em curso entrou na base da projecao');
    }
    // 3) os derivados andam JUNTOS com a energia
    if (meta > 0) {
      const at = 100 * parse(b.liq_gwh) / meta;
      if (Math.abs(parse(b.atingido) - at) > 0.02) f.push(id + ': atingido nao acompanhou liq_gwh');
      const falta = meta - parse(b.liq_gwh);
      const esp = falta > 0 ? falta : 0;
      if (Math.abs(parse(b.falta_gwh) - esp) > 0.02) f.push(id + ': falta_gwh nao acompanhou');
      if (falta > 0 && parse(a.falta_gwh) != null && !(parse(b.falta_gwh) < parse(a.falta_gwh))) {
        f.push(id + ': entregou mais e o que falta nao diminuiu');
      }
    }
    // 4) o que NAO e do dia fica parado
    PARADOS.forEach(k => {
      if (k in a && a[k] !== b[k]) f.push(id + ': ' + k + ' mudou, e nao devia');
    });
  });

  // 5) meses FECHADOS intactos
  const fech2 = {}; linhas.forEach(m => { if (m.fechado === 1) fech2[m.ufv + '|' + m.mes] = m; });
  fechadas.forEach(a => {
    const b = fech2[a.ufv + '|' + a.mes];
    if (JSON.stringify(a) !== JSON.stringify(b)) f.push(a.ufv + ' ' + a.mes + ': mes FECHADO mudou');
  });
  console.log('   meses fechados conferidos: ' + fechadas.length);

  // 6) IDEMPOTENTE: aplicar de novo, com a mesma energia, nao move mais nada
  const outra = clone(linhas);
  remendaManchete(outra, { mes, diaNum: 28, ate: '14:05', gwhPorUfv: gwh });
  if (JSON.stringify(outra) !== JSON.stringify(linhas)) {
    f.push('o remendo NAO e idempotente — rodando ~288 vezes por dia, o erro acumularia');
  }

  // 7) e ele PROVA que reprova: uma linha em que a energia nao entrou tem de acusar
  const quebrado = clone(linhas);
  const alvo = quebrado.find(m => m.mes === mes && m.fechado === 0 && m.liq_fechada_gwh != null);
  if (alvo) {
    const antes = alvo.liq_gwh;
    alvo.liq_gwh = alvo.liq_fechada_gwh;   // defeito: liq sem o dia em curso
    if (alvo.liq_gwh === antes) {
      f.push('o defeito plantado nao mudou nada — nao ha o que a guarda pegue');
    } else if (Math.abs(parse(alvo.liq_gwh) - (parse(alvo.liq_fechada_gwh) + parse(alvo.hoje_gwh))) <= 0.011) {
      f.push('a guarda de "liq = liq_fechada + hoje" NAO pega a linha quebrada');
    }
  }

  if (f.length) {
    console.error('\nREPROVADO:');
    f.slice(0, 20).forEach(x => console.error('   🔴 ' + x));
    process.exit(1);
  }
  console.log('\nOK · a hora e a energia andam juntas, a projecao fica parada, o mes fechado nao'
    + ' e tocado, e o remendo e idempotente.');
})();
