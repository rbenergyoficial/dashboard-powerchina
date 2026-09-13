/*
 * ensaio-setpoint-unidade.js — prova, contra o dado publicado, que o setpoint está em kW.
 *
 * 🔴 O DEFEITO QUE ELE GUARDA. Até 13/09/2026 o `setpoint_min` e o `setpoint_ger` saíam do
 *    gerador numa unidade que o PRÓPRIO gerador declarava não conhecer — "as duas colunas não
 *    estão na mesma unidade, e eu não sei qual é a de cada uma" —, e o painel de inversores
 *    desenhava `143709.94` num eixo sem unidade nenhuma. Número de unidade desconhecida na tela é
 *    o erro por fator de mil esperando acontecer.
 *
 * A unidade foi MEDIDA, e a prova é a SATURAÇÃO, não a aparência do número: quando o setpoint
 * está no teto, a potência ativa máxima do inversor encosta nele e para.
 *
 * O que este ensaio exige, sobre o blob PÚBLICO (sem segredo nenhum):
 *
 *   A · o arquivo DECLARA o esquema, e ele é o novo. Blob sem marca é blob em que a conversão
 *       não rodou, e aí metade da série estaria em W e metade em kW — duas unidades no mesmo
 *       arquivo é o pior dos mundos.
 *   B · a faixa é de kW: nenhum setpoint acima do teto físico do inversor.
 *   C · a SATURAÇÃO: com o setpoint no teto, a potência máxima medida encosta no teto e não passa.
 *   D · e o limite é RESPEITADO onde ele fica ativo o dia inteiro.
 *   E · NEGATIVA · a migração converte um histórico em W, e o faz pela MARCA e não pelo valor:
 *       um setpoint de 36,9 W tem de virar 0,04 kW, e é justamente ele que um corte por
 *       magnitude deixaria para trás.
 *
 * uso: node ensaio-setpoint-unidade.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');

const URL = 'https://rbenergydata.blob.core.windows.net/dados/perdas_inv.json';
const NOMINAL_KW = 320;          // POTÊNCIA ATIVA NOMINAL do SG350HX como o parque o configura
const TETO_KW = 352;             // 110% da nominal — a sobrecarga configurada, medida no dado

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };

const le = () => new Promise((ok, erro) => {
  https.get(URL, { family: 4 }, (r) => {
    /* só o 404 é ausência; qualquer outra falha estoura, em vez de virar "nada a conferir" */
    if (r.statusCode !== 200) { r.resume(); erro(new Error('HTTP ' + r.statusCode)); return; }
    const c = [];
    r.on('data', (d) => c.push(d));
    r.on('end', () => {
      try { let b = Buffer.concat(c); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        ok(JSON.parse(b.toString('utf8'))); } catch (e) { erro(e); }
    });
  }).on('error', erro);
});

const num = (x) => typeof x === 'number' && isFinite(x);
const q = (v, p) => v[Math.floor(v.length * p)];

(async () => {
  const j = await le();
  const s = Array.isArray(j.serie) ? j.serie : [];
  if (!s.length) { console.log('🔴 blob sem serie'); process.exit(1); }
  console.log(s.length + ' linhas · esquema declarado: ' + JSON.stringify(j.esquema));

  console.log('');
  console.log('A · o arquivo declara o esquema, e ele é o de kW');
  /* ⚠️ `Number(undefined)` é NaN, e TODA comparação com NaN é falsa: escrito como
     `Number(j.esquema) < 2`, um blob SEM a marca escapava do ramo certo e a mensagem acusava o
     campo errado — o erro que faz procurar defeito no conteúdo quando o defeito é o pressuposto. */
  if (!(Number(j.esquema) >= 2)) {
    falha('o blob está no esquema ' + (j.esquema === undefined ? '(sem marca)' : j.esquema)
      + ': a conversão de W para kW não rodou');
  } else if (!/kW/.test(String(j.unidade_setpoint || ''))) {
    falha('o esquema é 2 mas `unidade_setpoint` não diz kW: ' + JSON.stringify(j.unidade_setpoint));
  } else {
    console.log('  esquema ' + j.esquema + ' · ' + String(j.unidade_setpoint).slice(0, 60) + '…');
  }

  console.log('');
  console.log('B · a faixa é de kW, não de W');
  const sp = [];
  for (const l of s) for (const k of ['setpoint_min', 'setpoint_ger']) if (num(l[k])) sp.push(l[k]);
  sp.sort((a, b) => a - b);
  const alto = sp.filter((x) => x > TETO_KW * 1.02);
  if (alto.length) {
    falha(alto.length + ' valor(es) acima do teto físico de ' + TETO_KW + ' kW — o maior é '
      + sp[sp.length - 1] + ': o arquivo ainda tem setpoint em W');
  } else {
    console.log('  ' + sp.length + ' valores · máximo ' + sp[sp.length - 1] + ' kW · teto '
      + TETO_KW + ' kW (110% da nominal de ' + NOMINAL_KW + ' kW)');
  }

  console.log('');
  console.log('C · a SATURAÇÃO — é ela que prova a unidade');
  const noTeto = s.filter((l) => num(l.setpoint_ger) && num(l.p_ca_max)
    && Math.abs(l.setpoint_ger - TETO_KW) < 0.5);
  if (noTeto.length < 100) {
    falha('só ' + noTeto.length + ' dias com o setpoint no teto: a prova não se sustenta');
  } else {
    const p = noTeto.map((l) => l.p_ca_max).sort((a, b) => a - b);
    const p99 = q(p, 0.99), max = p[p.length - 1];
    console.log('  ' + noTeto.length + ' dias no teto · potência máxima: p99 ' + p99.toFixed(1)
      + ' kW · máximo ' + max.toFixed(1) + ' kW');
    /* 🔴 o p99 tem de ENCOSTAR no teto (é isso que significa saturar) e o máximo não pode
       dispará-lo: os dois lados juntos, senão "abaixo do teto" passaria por saturação */
    if (p99 < TETO_KW * 0.98) falha('o p99 (' + p99.toFixed(1) + ') não encosta no teto: não há saturação, e a unidade não está provada');
    if (max > TETO_KW * 1.02) falha('o máximo (' + max.toFixed(1) + ') passa do teto em mais de 2%');
  }

  console.log('');
  console.log('D · onde o limite fica ativo o dia inteiro, ele é respeitado');
  /* ⚠️ o filtro é por setpoint ALTO de propósito: `setpoint_ger` é a mediana do dia e `p_ca_max` é
     o pico, então num dia de restrição parcial o pico vem de fora da janela restrita e a razão
     estoura por construção. Foi assim que duas leituras minhas caíram antes de a unidade sair. */
  const ativo = s.filter((l) => num(l.setpoint_ger) && num(l.p_ca_max)
    && l.setpoint_ger >= 250 && l.setpoint_ger < TETO_KW - 1 && l.p_ca_max > 1);
  if (ativo.length < 500) {
    falha('só ' + ativo.length + ' dias na faixa em que o limite fica ativo o dia todo');
  } else {
    const r = ativo.map((l) => l.p_ca_max / l.setpoint_ger).sort((a, b) => a - b);
    const med = q(r, 0.5), dentro = r.filter((x) => x <= 1.05).length / r.length;
    console.log('  ' + ativo.length + ' dias · razão potência/setpoint mediana ' + med.toFixed(2)
      + ' · dentro de 1,05 em ' + (dentro * 100).toFixed(0) + '%');
    if (med > 1.15) falha('a mediana ' + med.toFixed(2) + ' diz que a potência passa do setpoint: a unidade não fecha');
    if (dentro < 0.7) falha('só ' + (dentro * 100).toFixed(0) + '% respeitam o limite');
  }

  console.log('');
  console.log('E · NEGATIVA · a migração converte pela MARCA, e alcança o valor que a magnitude deixaria');
  /* o mesmo código do gerador, escrito aqui de forma independente: se os dois divergirem, o
     ensaio reprova em vez de o blob passar a misturar unidades */
  const migra = (arq) => {
    if (Number(arq.esquema) >= 2) return { convertidos: 0, serie: arq.serie };
    let n = 0;
    for (const l of arq.serie) for (const k of ['setpoint_min', 'setpoint_ger']) {
      if (typeof l[k] === 'number') { l[k] = Math.round((l[k] / 1000) * 100) / 100; n += 1; }
    }
    return { convertidos: n, serie: arq.serie };
  };
  const velho = { esquema: 1, serie: [
    { setpoint_min: 36.9, setpoint_ger: 352000 },      // o caso que a magnitude perderia
    { setpoint_min: 14400, setpoint_ger: 58880 },
    { setpoint_min: null, setpoint_ger: 0 },
  ] };
  const r1 = migra(velho);
  if (r1.convertidos !== 5) falha('a migração converteu ' + r1.convertidos + ' valores, esperava 5');
  if (velho.serie[0].setpoint_min !== 0.04) falha('o valor de 36,9 W virou ' + velho.serie[0].setpoint_min + ' e não 0,04 kW — é ele que um corte por magnitude deixaria em W');
  if (velho.serie[0].setpoint_ger !== 352) falha('o teto virou ' + velho.serie[0].setpoint_ger + ' e não 352');
  if (velho.serie[2].setpoint_ger !== 0) falha('o zero deixou de ser zero: ' + velho.serie[2].setpoint_ger);
  /* e um arquivo JÁ migrado não se converte de novo — dividir duas vezes por mil é o mesmo
     defeito com o sinal trocado */
  const novo = { esquema: 2, serie: [{ setpoint_ger: 352 }] };
  const r2 = migra(novo);
  if (r2.convertidos !== 0 || novo.serie[0].setpoint_ger !== 352) falha('um arquivo já migrado foi convertido OUTRA vez: ' + novo.serie[0].setpoint_ger);
  if (!mau) console.log('  5 valores convertidos · 36,9 W → 0,04 kW · o teto → 352 kW · arquivo já migrado fica intacto');

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio do setpoint: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
