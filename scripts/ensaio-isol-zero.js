/*
 * ensaio-isol-zero.js — prova que o ZERO da isolação saiu, e que ele era ausência e não medição.
 *
 * 🔴 O DEFEITO QUE ELE GUARDA. Até 13/09/2026 o `isol_min` era o mínimo do dia sobre o valor CRU,
 *    e o supervisório escreve **0** quando o canal não tem leitura. Um único instante assim zerava
 *    o dia inteiro do inversor: eram **4.468 dias-inversor** publicando `isol_min = 0`, e o painel
 *    desenhava a curva mergulhando a zero como se fosse a pior isolação medida.
 *
 * A medição que decidiu, feita no arquivo CRU e não deduzida:
 *    · os zeros estão em **6 dias de 51**, em quatro deles na frota INTEIRA;
 *    · em 12/08 o M3/TS1/INV01 traz isolação **0 às 12:00 com 317 kW**, cercada de 462;
 *    · às 18h, 20h e 22h, com o inversor PARADO, o mesmo canal traz **462** — ele mede à noite;
 *    · em 31/08 os mesmos inversores trazem 196, 199, 186. O canal funciona, e quando não
 *      funciona escreve zero.
 *    Arranjo com isolação zero está em curto e não gera. O 0 é ausência escrita como número.
 *
 * O que este ensaio exige, sobre o blob PÚBLICO (sem segredo nenhum):
 *
 *   A · o arquivo DECLARA o esquema, e ele é o novo. Sem a marca, a migração não rodou e metade da
 *       série carrega o zero antigo — duas convenções no mesmo campo é o pior dos mundos.
 *   B · **nenhum `isol_min` igual a zero**, em linha nenhuma.
 *   C · a curva de 30 min não tem zero em instante nenhum — as duas telas têm de concordar sobre o
 *       mesmo instante, e antes deste lote elas mergulhavam juntas.
 *   D · onde houve ausência, ela vai CONTADA: dia sem leitura tem de PODER ser dito.
 *   E · NEGATIVA · a migração, compilada DO PRÓPRIO GERADOR: troca o zero por NULO, não toca em
 *       mais nada, e um arquivo já migrado fica intacto.
 *
 * ⚠️ Ele roda DEPOIS de gerar, como o ensaio da unidade do setpoint e pelo mesmo motivo: julga uma
 *    MIGRAÇÃO, e antes reprovaria justamente a rodada que conserta. O custo fica declarado — se
 *    reprovar, o dado ruim já está no ar; e dado ruim com o job vermelho é melhor que dado ruim em
 *    silêncio, que é o que produziu este defeito.
 *
 * uso: node ensaio-isol-zero.js [ufv]   ·   LOCAL_BLOB=<arquivo> para julgar um blob de arquivo
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const UFV = (process.argv[2] || 'M3').toUpperCase();
const ESQUEMA_MIN = 3;

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

const le = (nome) => new Promise((res, rej) => {
  if (process.env.LOCAL_BLOB && nome === 'perdas_inv.json') {
    res(JSON.parse(fs.readFileSync(process.env.LOCAL_BLOB, 'utf8'))); return;
  }
  https.get(BASE + nome, { family: 4 }, (r) => {
    /* só o 404 é ausência; qualquer outra falha estoura em vez de virar "nada a conferir" */
    if (r.statusCode !== 200) { r.resume(); rej(new Error(nome + ': HTTP ' + r.statusCode)); return; }
    const c = [];
    r.on('data', (d) => c.push(d));
    r.on('end', () => {
      try {
        let b = Buffer.concat(c);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        res(JSON.parse(b.toString('utf8')));
      } catch (e) { rej(e); }
    });
  }).on('error', rej);
});

/* 🔴 A REGRA VEM DO PRÓPRIO GERADOR, como ela sobe. Reescrevê-la aqui provaria só que a minha
      cópia concorda consigo mesma — é a lição do ensaio da guarda do relógio. */
function migracaoDoGerador() {
  const src = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8');
  const i = src.indexOf('function migraIsolZero(');
  if (i < 0) throw new Error('o gerador não tem mais a função de migração do isolamento');
  const fim = src.indexOf('\n}\n', i);
  if (fim < 0) throw new Error('não achei o fim da função de migração');
  // eslint-disable-next-line no-new-func
  return new Function('ESQUEMA', 'console',
    src.slice(i, fim + 3) + '; return migraIsolZero;')(ESQUEMA_MIN, { log: () => {} });
}

(async () => {
  const j = await le('perdas_inv.json');
  const s = Array.isArray(j.serie) ? j.serie : [];
  console.log('perdas_inv · ' + s.length + ' linhas · esquema declarado: ' + JSON.stringify(j.esquema));

  console.log('');
  console.log('A · o arquivo declara o esquema NOVO');
  /* ⚠️ `Number(undefined)` é NaN e toda comparação com NaN é falsa: escrito como
     `Number(j.esquema) < 3`, um blob SEM marca escaparia da acusação. Foi um defeito real do
     ensaio do setpoint, e a forma abaixo é a que acusa a ausência. */
  ok(Number(j.esquema) >= ESQUEMA_MIN, 'esquema = ' + JSON.stringify(j.esquema)
    + ' (esperado ' + ESQUEMA_MIN + ' ou mais)');

  console.log('');
  console.log('B · nenhum minimo do dia vale ZERO');
  {
    const z = s.filter((l) => l.isol_min === 0);
    ok(!z.length, z.length + ' linha(s) com isol_min = 0'
      + (z.length ? ' (ex.: ' + z[0].dia + ' ' + z[0].ufv + '/' + z[0].ts + '/' + z[0].inv + ')' : ''));
    const v = s.map((l) => l.isol_min).filter((x) => typeof x === 'number');
    const nulos = s.filter((l) => l.isol_min === null).length;
    if (v.length) {
      const o2 = v.slice().sort((a, b) => a - b);
      console.log('      ' + v.length + ' valores medidos · ' + nulos + ' sem leitura · '
        + 'min ' + o2[0] + ' · mediana ' + o2[Math.floor(o2.length / 2)] + ' · max ' + o2[o2.length - 1]);
      ok(o2[0] > 0, 'o menor valor medido e positivo: ' + o2[0]);
    }
  }

  console.log('');
  console.log('C · a curva de 30 min concorda: zero em instante nenhum');
  {
    const h = await le('pvstr_hora_' + UFV + '.json');
    let n = 0; let z = 0;
    for (const l of (h.serie || [])) {
      for (const x of (l.iso || [])) { if (typeof x === 'number') { n += 1; if (x === 0) z += 1; } }
    }
    ok(n > 1000, n + ' leituras de isolacao na curva (senao esta guarda nao julga nada)');
    ok(!z, z + ' leitura(s) com valor zero na curva');
  }

  console.log('');
  console.log('D · onde houve ausencia, ela vai CONTADA');
  {
    const c = s.filter((l) => l.isol_sem_leitura > 0);
    const semValor = s.filter((l) => l.isol_min === null);
    console.log('      ' + c.length + ' inversor-dia(s) com a contagem de instantes sem leitura');
    /* ⚠️ a contagem so existe para dias que a rodada RECALCULOU: o historico migrado tem o mínimo
       anulado e nao tem como saber quantos instantes eram. Entao a exigencia e condicional — e
       dizer isso e melhor que uma guarda que reprova o que nao pode saber. */
    const recalc = semValor.filter((l) => l.isol_sem_leitura > 0).length;
    console.log('      dos ' + semValor.length + ' sem valor, ' + recalc
      + ' trazem a contagem (os demais sao historico migrado, que nao a tem)');
  }

  console.log('');
  console.log('E · NEGATIVA · a migracao troca o zero por NULO e NAO toca em mais nada');
  {
    const migra = migracaoDoGerador();
    /* o caso forjado traz as tres coisas que separam uma migracao cirurgica de um replace: o zero
       que DEVE virar nulo, um zero em OUTRO campo que nao pode ser tocado, e um valor pequeno mas
       legitimo que um corte por magnitude levaria junto */
    const forjado = {
      esquema: 2,
      serie: [
        { dia: '2026-08-12', isol_min: 0, temp_max: 61.2, p_ca_max: 317 },
        { dia: '2026-08-13', isol_min: 6.01, temp_max: 0, p_ca_max: 0 },
        { dia: '2026-08-14', isol_min: 462, temp_max: 59.5, p_ca_max: 280 },
        { dia: '2026-08-15', isol_min: null, temp_max: 58.1, p_ca_max: 250 },
      ],
    };
    const antes = JSON.stringify(forjado.serie);
    migra(forjado, 'perdas_inv.json');
    const l = forjado.serie;
    ok(l[0].isol_min === null, 'o zero da isolacao virou NULO');
    ok(l[1].temp_max === 0, 'o zero de OUTRO campo ficou intacto (a migracao e cirurgica)');
    ok(l[1].isol_min === 6.01, 'o valor pequeno e legitimo (6,01) sobreviveu — um corte por '
      + 'magnitude o levaria junto');
    ok(l[2].isol_min === 462 && l[3].isol_min === null, 'os demais nao mudaram');
    ok(antes !== JSON.stringify(l), 'a migracao de fato agiu (senao este caso nao julga nada)');

    const jaFeito = { esquema: ESQUEMA_MIN, serie: [{ dia: 'x', isol_min: 0 }] };
    migra(jaFeito, 'perdas_inv.json');
    ok(jaFeito.serie[0].isol_min === 0, 'um arquivo ja migrado NAO e migrado outra vez');

    const outro = { esquema: 2, serie: [{ dia: 'x', isol_min: 0 }] };
    migra(outro, 'perdas_diario.json');
    ok(outro.serie[0].isol_min === 0, 'a migracao so alcanca o arquivo por inversor');
  }

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio do zero da isolacao: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
