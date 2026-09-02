// gen-scada-intake-watchdog.js — a INTAKE do SCADA parou de chegar?
//
// 🔴 POR QUE ELE EXISTE
// O container `scada-raw` e alimentado pelo fluxo "SCADA SharePoint para Blob" do Power Automate.
// Em 28/08/2026 ele falhou DEZ vezes numa semana e ninguem soube: os geradores que consomem o
// container continuaram rodando, republicando fielmente o que ja tinham, e nada ficou vermelho.
// A solarimetria parou em 06/08 e o comparativo ficou tres dias atras — descobertos por um humano
// olhando a tela, dias depois.
//
// 🔴 O MODO DE FALHAR E O PIOR DESTA CASA: nada quebra, nada fica vazio, e a pagina publica um
// dado velho com cara de dado de hoje. Este vigia existe para trocar isso por um alerta.
//
// ⚠️ ELE NAO SUBSTITUI A MIGRACAO. O fluxo continua sendo a ponte; o vigia so faz a queda dela
//    ser barulhenta. Quando a coleta sair do Power Automate (`gen-scada-intake.js`), ele continua
//    valendo — ai vigiando o coletor novo, que e o mesmo container.
//
// O QUE ELE MEDE
//   A idade do arquivo mais recente DE CADA FAMILIA. Familia e o consumidor: cada uma tem
//   cadencia propria, e uma media entre elas esconderia justamente a que parou.
//
// ⚠️ COMPARA COM O RELOGIO, NUNCA COM O PROPRIO DADO. Quando a ponte quebra, o container
//    simplesmente para de receber — nao ha registro dizendo que deveria ter chegado. E a mesma
//    razao pela qual o vigia do MUST olha a hora e nao a serie.
//
// MODOS
//   MODO=medir   (nao alerta) imprime a DISTRIBUICAO dos intervalos por familia. E daqui que os
//                limiares saem — limiar escolhido a esmo reprova o caso normal, e ja fez isso
//                tres vezes nesta casa.
//   MODO=vigiar  (padrao) julga contra os limiares e alerta.
//
// Ambiente: DADOS_STORAGE, RAW_CONTAINER=scada-raw, e (para alertar) GITHUB_TOKEN / GH_REPO.
'use strict';
const { BlobServiceClient } = require('@azure/storage-blob');
const { alerta } = require('./lib-alerta');

const RAW = process.env.RAW_CONTAINER || 'scada-raw';
const MODO = (process.env.MODO || 'vigiar').toLowerCase();
const SECO = /^(1|true|sim)$/i.test(process.env.SECO || '');

// ── as familias ──────────────────────────────────────────────────────────────────────────────
// 🔴 A LISTA E DERIVADA DO COLETOR, nao copiada dele. `gen-scada-intake.js` ja define quais
//    arquivos existem e quem os consome; uma segunda copia aqui envelheceria em outra direcao, e
//    o vigia passaria a vigiar um conjunto que ninguem le — dando a impressao de cobertura sem
//    ter nenhuma. A primeira versao deste arquivo copiava, e a guarda que eu escrevi para
//    detectar a divergencia comparava os campos ERRADOS (`casa` contra `exige`, que respondem a
//    perguntas diferentes): guarda que compara a coisa errada nao e guarda.
//
// O que mora AQUI e so o que o coletor nao tem: o rotulo legivel e os dois limiares.
// `alerta_h`/`critico_h` NULOS ate a medicao — publicar limiar antes de medir e o defeito que
// este cabecalho existe para evitar. Rode MODO=medir e preencha com o numero MEDIDO.
const PERFIL = {
  // chave: a fonte da expressao `quando` do coletor — e o que os liga sem ambiguidade
  '/\\.xlsx$/i': { nome: 'M<parque>.xlsx (SCADA por usina)', alerta_h: null, critico_h: null },
  '/_?IRR_GERAL_\\d{8}_\\d{6}\\.csv$/i': { nome: 'IRR_GERAL (estacao)', alerta_h: null, critico_h: null },
  '/(^|_)IRR_\\d{8}_\\d{6}\\.csv$/i': { nome: 'IRR (sensor GER_IRR)', alerta_h: null, critico_h: null },
  '/Trafo_\\d{8}_\\d{6}\\.csv$/i': { nome: 'Trafo (SE)', alerta_h: null, critico_h: null },
  '/M\\d{2}_\\d{8}_\\d{6}\\.csv$/i': { nome: 'M<NN> csv (inversores/perdas)', alerta_h: null, critico_h: null },

  // ⚠️ `IIRR_` fica de fora do JULGAMENTO de proposito (`vigia: false`): sao despejos manuais de
  //    365 dias, exportados de vez em quando. Vigiar cadencia de algo que nao tem cadencia
  //    produz alarme que acende sempre — e alarme que acende sempre ensina a ignorar a
  //    ferramenta. Ele continua sendo CONTADO, para aparecer na medicao.
  '/_?IIRR_\\d{8}_\\d{6}\\.csv$/i': { nome: 'IIRR (despejo manual)', vigia: false },
};

const INTAKE = require('./gen-scada-intake.js');

// ⚠️ A ORDEM e a do coletor, e ela importa: `IIRR_` e `IRR_GERAL_` tem de ser testados ANTES de
//    `IRR_`, senao o terceiro padrao os captura. Preservar a ordem e o motivo de percorrer
//    CONSUMIDORES em vez de iterar o objeto PERFIL.
const FAMILIAS = INTAKE.CONSUMIDORES.map((c) => {
  const p = PERFIL[String(c.quando)];
  if (!p) {
    // 🔴 Falha ALTA: familia nova no coletor e desconhecida aqui significa entrada que ninguem
    //    vigia. Silenciar isso seria o defeito original com outra roupa.
    throw new Error('familia sem perfil no vigia: ' + c.quem + ' ' + c.quando
      + ' — acrescente em PERFIL (e meca o limiar antes)');
  }
  return { nome: p.nome, quem: c.quem, casa: c.quando,
    vigia: p.vigia !== false, alerta_h: p.alerta_h, critico_h: p.critico_h };
});

function familiaDe(nome) {
  for (const f of FAMILIAS) if (f.casa.test(nome)) return f;
  return null;
}

async function lista() {
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE)
    .getContainerClient(RAW);
  const out = [];
  for await (const b of c.listBlobsFlat()) {
    out.push({ nome: b.name, ms: +new Date(b.properties.lastModified) });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function porFamilia(blobs) {
  const m = new Map(FAMILIAS.map((f) => [f.nome, []]));
  for (const b of blobs) {
    const f = familiaDe(b.nome.split('/').pop());
    if (f) m.get(f.nome).push(b);
  }
  return m;
}

function pct(v, p) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

// ── MODO=medir ───────────────────────────────────────────────────────────────────────────────
function medir(m) {
  const agora = Date.now();
  console.log('container `' + RAW + '` · ' + new Date(agora).toISOString() + '\n');
  for (const f of FAMILIAS) {
    const v = m.get(f.nome);
    if (!v.length) { console.log(f.nome.padEnd(38) + 'NENHUM arquivo'); continue; }
    const gaps = [];
    for (let i = 1; i < v.length; i++) gaps.push((v[i].ms - v[i - 1].ms) / 3600000);
    const idade = (agora - v[v.length - 1].ms) / 3600000;
    console.log(f.nome.padEnd(38) + v.length + ' arquivos');
    console.log('   ultimo    ' + new Date(v[v.length - 1].ms).toISOString()
      + '  (ha ' + idade.toFixed(1) + ' h)   ' + v[v.length - 1].nome.split('/').pop());
    if (gaps.length) {
      console.log('   intervalo entre chegadas (h):  mediana ' + pct(gaps, 0.5).toFixed(1)
        + ' · p90 ' + pct(gaps, 0.9).toFixed(1)
        + ' · p99 ' + pct(gaps, 0.99).toFixed(1)
        + ' · maximo ' + Math.max(...gaps).toFixed(1));
      // a distribuicao inteira, para separar familia de gaps como o caso do spanNulls
      const fx = [6, 12, 24, 36, 48, 72, 168, 1e9];
      const cont = fx.map((t, i) => gaps.filter(
        (g) => g <= t && g > (i ? fx[i - 1] : 0)).length);
      console.log('   ate 6h ' + cont[0] + ' · 12h ' + cont[1] + ' · 24h ' + cont[2]
        + ' · 36h ' + cont[3] + ' · 48h ' + cont[4] + ' · 72h ' + cont[5]
        + ' · 7d ' + cont[6] + ' · alem ' + cont[7]);
      // 🔴 a SUGESTAO nao vira limiar sozinha: ela e o que o humano confere antes de gravar.
      console.log('   sugestao: alerta ' + Math.ceil(pct(gaps, 0.99) * 1.5)
        + ' h · critico ' + Math.ceil(pct(gaps, 0.99) * 3) + ' h'
        + '   (1,5x e 3x o p99)');
    }
    console.log('');
  }
}

// ── MODO=vigiar ──────────────────────────────────────────────────────────────────────────────
async function vigiar(m) {
  const agora = Date.now();
  const julgadas = FAMILIAS.filter((f) => f.vigia);
  const semLimiar = julgadas.filter((f) => f.alerta_h == null);
  if (semLimiar.length === julgadas.length) {
    // 🔴 Falha ALTA. Um vigia sem limiar passaria sempre, e um vigia que sempre passa e
    //    indistinguivel de vigia nenhum — com o agravante de dar a impressao de cobertura.
    throw new Error('nenhuma familia tem limiar: rode MODO=medir e preencha FAMILIAS');
  }
  const achados = [];
  const linhas = [];
  for (const f of julgadas) {
    const v = m.get(f.nome);
    const idade = v.length ? (agora - v[v.length - 1].ms) / 3600000 : Infinity;
    const est = f.alerta_h == null ? 'sem limiar'
      : idade >= f.critico_h ? 'CRITICO' : idade >= f.alerta_h ? 'ALERTA' : 'ok';
    linhas.push('  ' + f.nome.padEnd(38)
      + (v.length ? idade.toFixed(1) + ' h' : 'VAZIA').padStart(9)
      + '   limiar ' + (f.alerta_h == null ? '—' : f.alerta_h + '/' + f.critico_h + ' h')
      + '   ' + est);
    if (est === 'ALERTA' || est === 'CRITICO') {
      achados.push({ f, idade, est, ultimo: v.length ? v[v.length - 1] : null });
    }
  }
  console.log('container `' + RAW + '` · ' + new Date(agora).toISOString());
  console.log(linhas.join('\n'));
  if (semLimiar.length) {
    console.log('\n⚠️  ' + semLimiar.length + ' familia(s) SEM limiar — nao sao julgadas: '
      + semLimiar.map((f) => f.nome).join(', '));
  }

  const chave = 'scada-intake-parada';
  if (!achados.length) {
    console.log('\nintake em dia.');
    if (!SECO) await alerta({ tipo: 'scada-intake', chave, resolve: true,
      assunto: 'SCADA · intake normalizada',
      corpo: 'A entrada do container `' + RAW + '` voltou a receber arquivo em todas as '
        + 'familias vigiadas.\n\n' + linhas.join('\n') });
    return 0;
  }

  const critico = achados.some((a) => a.est === 'CRITICO');
  const corpo = [
    'A entrada do container `' + RAW + '` parou de receber arquivo.',
    '',
    'Os geradores que a consomem NAO falham por isso: eles republicam o que ja tinham, e a',
    'pagina passa a mostrar dado velho com cara de dado de hoje. Por isso o alerta.',
    '', linhas.join('\n'), '',
    'Familias afetadas:',
    ...achados.map((a) => '  · ' + a.f.nome + ' — consumida por ' + a.f.quem
      + ' — ultimo arquivo ha ' + a.idade.toFixed(1) + ' h'
      + (a.ultimo ? ' (' + a.ultimo.nome.split('/').pop() + ')' : ' — familia VAZIA')),
    '',
    'Onde olhar: o fluxo "SCADA SharePoint para Blob" no Power Automate, e o deposito no',
    'SharePoint. Em 28/08/2026 a ponte falhou 10x numa semana sem nada acusar.',
  ].join('\n');
  console.log('\n' + (critico ? 'CRITICO' : 'ALERTA') + ': '
    + achados.length + ' familia(s) atrasada(s)');
  if (!SECO) {
    await alerta({ tipo: 'scada-intake', chave,
      assunto: (critico ? '[CRITICO] ' : '[ALERTA] ') + 'SCADA · intake parada ('
        + achados.map((a) => a.f.quem).join(', ') + ')',
      corpo });
  }
  // 🔴 NAO derruba o job: ele roda junto de outra coisa e o alerta ja e a saida.
  return 0;
}

(async () => {
  const blobs = await lista();
  const m = porFamilia(blobs);
  const vistos = [...m.values()].reduce((s, v) => s + v.length, 0);
  console.log(vistos + ' de ' + blobs.length + ' blobs caem numa familia vigiada'
    + ' (o resto e despejo manual ou nome fora do contrato)\n');
  if (MODO === 'medir') return medir(m);
  return vigiar(m);
})().catch((e) => { console.error(e.message); process.exit(1); });
