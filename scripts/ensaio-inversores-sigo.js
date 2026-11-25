'use strict';
/*
 * ensaio-inversores-sigo.js — as trocas do inversores.json pelo arquivo do SIGO (lote inversores-sigo, 24/11/2026), sem rede:
 * 1. ponta a ponta: um arquivo do SIGO de mentira (8 trocas, estoque, catálogo, movimentos de fusível), a planilha de alarmes
 *    e a base de alarmes de mentira, o gerador de verdade; a planilha de falhas que ainda chega ao contêiner é ignorada;
 * 2. cada número que os painéis leem sai do arquivo do SIGO: trocas, térmicas, reposição, estoque, fusíveis, fases, códigos,
 *    hora do selo; nenhum número de série, chamado, RNC ou procedimento do manual chega à saída;
 * 3. o arquivo com defeito é RECUSADO, cada um pela sua conferência (o arquivo é reassinado, para a impressão digital não
 *    pegar o que era da conferência específica): planilha no lugar do SIGO, conteúdo editado, troca a menos, número repetido,
 *    usina fora, posição, data, fusíveis, fases, tipo, catálogo, estoque, movimentos, saldo, hora;
 * 4. dado sensível que chega à saída derruba a rodada (série retirada, série instalada, série de estoque);
 * Depois PLANTA defeitos no próprio gerador e exige que cada um reprove.
 * Dado real não entra aqui: o repositório é público e o arquivo do SIGO traz número de série e chamado. A conferência com o
 * dado real (estado de 23/11) está no livro de bordo do pipeline, lote inversores-sigo.
 * uso: node scripts/ensaio-inversores-sigo.js   (precisa do pacote xlsx; sai 1 se algo falhar)
 */
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'), crypto = require('crypto'), { spawnSync } = require('child_process');
const GEN = path.join(__dirname, 'gen-inversores.js');

const sha = (B) => { const s = Object.assign({}, B); delete s.meta; return crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16); };
// reassina: refaz a impressão digital e as contagens declaradas, como o SIGO faria ao montar o arquivo
function assina(doc, { linhas = true } = {}) {
  const B = doc.BASE;
  if (linhas) doc.META.linhas = { substituicoes: B.substituicoes.length, codigos: B.codigos.length, inferencia: B.inferencia.length,
    estoqueNovos: B.estoqueSerie.novos.length, estoqueReparados: B.estoqueSerie.reparados.length };
  delete B.meta;
  doc.META.sha256_16 = sha(B);
  B.meta = Object.assign({}, doc.META);
  return doc;
}
const T = (item, parque, ts, inv, desc, data, sub, codigo, fus, fases, extra) => Object.assign({ item, parque, ts, inv, codigo,
  origemCodigo: codigo == null ? null : 'Reportado / Reported', nomeFalha: 'x', descricaoFalha: desc, data, sn: 'A23ENSAIO' + String(item).padStart(3, '0'),
  dataSubstituicao: sub, fusiveisDanificados: fus, fases, chamado: String(700000 + item), rnc: 'PWC-QUA-RNC-9' + String(item).padStart(3, '0') + '-SUN-00',
  markup: 'A26ENSAIO' + String(item).padStart(3, '0'), origem: 'New', comissionado: 'Yes', jaSubstituido: 'Não · 1ª troca' }, extra || {});
function sigoDeMentira() {
  const BASE = {
    substituicoes: [
      T(1, 'M1', 'TS1', 'INV1', 'Carbonizado / Carbonized', '2026-01-10', '2026-01-10', 40, 0, 0),
      T(2, 'M2', 'TS2', 'INV3', 'Inflado / Inflated', '2026-02-05', '2026-02-07', 36, 2, 'L1/L2'),
      T(3, 'M6', 'TS4', 'INV10', 'Ventoinha / Fan failure', '2026-03-01', '2026-03-01', null, 0, 0, { origem: 'Repaired' }),
      T(4, 'M8', 'TS3', 'INV10', 'Anomalia / Anomaly', '2026-04-02', '2026-04-02', 40, 0, 0, { parqueOriginal: 'M10' }),
      T(166, 'M1', 'TS7', 'INV2', 'Carbonizado / Carbonized', '2026-08-20', '2026-08-21', 40, 3, 'L1/L2/L3'),
      T(167, 'M9', 'TS1', 'INV5', 'Falha MPPT / MPPT failure', '2026-09-11', '2026-09-11', 59, 1, 'L2'),
      T(168, 'M7', 'TS2', 'INV1', 'Superaquecimento / Overheating', '2026-10-03', '2026-10-04', 36, 2, 'L1/L3'),
      T(169, 'M6', 'TS4', 'INV10', 'Carbonizado / Carbonized', '2026-11-02', '2026-11-02', 40, 0, 0, { jaSubstituido: 'Sim · 2ª troca' }),
    ],
    codigos: [
      { codigo: 36, nome: 'Temperatura alta / High temperature', acaoCorretiva: 'Procedimento de ensaio: verificar a ventilação do inversor e limpar os filtros de ar.' },
      { codigo: 40, nome: 'Falha do sistema / System fault', acaoCorretiva: 'Procedimento de ensaio: desligar o inversor, aguardar cinco minutos e religar.' },
      { codigo: 59, nome: 'Falha de MPPT / MPPT fault', acaoCorretiva: 'Procedimento de ensaio: medir a tensão de cada entrada do arranjo e comparar.' },
    ],
    inferencia: [{ palavraChave: 'OVERHEATING', codigoAssumido: 36, base: 'ensaio' }, { palavraChave: 'CARBONIZED', codigoAssumido: 40, base: 'ensaio' }],
    estoqueSerie: {
      novos: [{ codigo: 'ASG0', serie: 'A25ENSAIO901', situacao: 'DISPONIVEL', ordem: 1 }, { codigo: 'ASG0', serie: 'A25ENSAIO902', situacao: 'DISPONIVEL', ordem: 2 },
        { codigo: 'ASG0', serie: 'A25ENSAIO903', situacao: 'USADO', ordem: null }],
      reparados: [{ status: 'RETORNO DE CONSERTO', serie: 'A23ENSAIO951', situacao: 'DISPONIVEL', ordem: 1 }, { status: 'RETORNO DE CONSERTO', serie: 'A23ENSAIO952', situacao: 'USADO', ordem: null }],
    },
    resumoAlmoxarifado: { novos: 2, reparados: 1, fusiveis: 8 },   // 10 − 1 + 5 recebidos − (3 + 1 + 2) das trocas do nº 166 em diante
    escopo: { modelo: 'Sungrow SG350HX' },
    fusiveisMov: [{ data: '2026-08-18', qtd: 10, tipo: 'entrada', obs: null }, { data: '2026-09-30', qtd: -1, tipo: 'ajuste', obs: 'contagem' },
      { data: '2026-10-20', qtd: 5, tipo: 'entrada', obs: null }],
  };
  return assina({ BASE, META: { origem: 'SIGO · Gestão (lançamento de troca de inversor)', sha256_16: '', gerado: '2026-11-20T10:05:00', modificadoEm: '2026-11-20T10:00:00', versao: '2.0', ausentes: [] } });
}
const copia = (x) => JSON.parse(JSON.stringify(x));
const SENSIVEIS = (doc) => [].concat(doc.BASE.substituicoes.flatMap((s) => [s.sn, s.markup, s.rnc]), doc.BASE.estoqueSerie.novos.map((x) => x.serie), doc.BASE.codigos.map((x) => x.acaoCorretiva));

// as entradas de mentira dos alarmes (a forma do ensaio-inversores-alarmes-base) e a planilha de falhas que deve ser ignorada
function montaPasta() {
  const XLSX = require('xlsx');
  const t0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-inv-sigo-')), raw = path.join(t0, 'raw'), hist = path.join(t0, 'hist');
  fs.mkdirSync(raw); fs.mkdirSync(hist);
  const wb1 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb1, XLSX.utils.aoa_to_sheet([['ITEM', 'SPV', 'TS', 'INV', 'FAILURE DESCRIPTION', 'DATE', 'Replacement Date'], [1, 'M02', 'TS02', 'INV09', 'FAN FAILURE', '10/03/2026', '11/03/2026']]), 'Controle');
  XLSX.writeFile(wb1, path.join(raw, 'p1.xlsx'));
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([['CAMPO', 'SUBCAMPO', 'INVERSOR', 'Horário', 'Tipo', 'Nome', 'Status'],
    ['M02', 'TS02', 'INV09', '15/03/2026', 'F', 'Queda da rede', 'Ocorre'], ['M01', 'TS07', 'INV02', '15/05/2026', 'F', 'Baixa resistência de isolamento', 'Ocorre']]), 'M02');
  XLSX.writeFile(wb2, path.join(raw, 'p2.xlsx'));
  fs.writeFileSync(path.join(hist, 'alarmes_logger_2026_07.json'), JSON.stringify({ esquema: 1, dias: ['2026-07-03'], msg: ['isolacao_baixa'],
    ev: [{ c: 'inversor_falha', t: 'M2/TS2/INV9', i: '2026-07-03T10:00:00', m: 0 }] }));
  return { t0, raw, hist };
}
const PASTA = { atual: null };
function roda(genPath, doc, { gz = false, bruto = null, tz = 'UTC' } = {}) {
  const P = PASTA.atual, arq = path.join(P.t0, 'sigo.json' + (gz ? '.gz' : '')), out = path.join(P.t0, 'out.json');
  const txt = bruto != null ? bruto : JSON.stringify(doc);
  fs.writeFileSync(arq, gz ? zlib.gzipSync(Buffer.from(txt, 'utf8')) : txt);
  try { fs.unlinkSync(out); } catch (e) { /* não havia */ }
  const r = spawnSync(process.execPath, [genPath], { encoding: 'utf8', env: { ...process.env, TZ: tz, ALARMES_CORTE_MIN: '2026-07', LOCAL_DIR: P.raw, LOCAL_HIST_DIR: P.hist, LOCAL_SIGO: arq, LOCAL_OUT: out } });
  return { ok: r.status === 0, log: (r.stdout || '') + (r.stderr || ''), o: r.status === 0 ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

// os defeitos no ARQUIVO: cada um tem de ser recusado pela conferência dele (o trecho esperado da mensagem)
const DEFEITOS = [
  ['a planilha no lugar do SIGO', 'a origem não é o SIGO', (d) => { d.META.origem = 'Inverter failure and Commissioning Control automated.xlsm'; return assina(d); }],
  ['conteúdo editado sem refazer a impressão digital', 'impressão digital', (d) => { d.BASE.substituicoes[0].dataSubstituicao = '2026-01-11'; return d; }],
  ['troca a menos que o declarado', 'declaradas', (d) => { d.BASE.substituicoes.pop(); return assina(d, { linhas: false }); }],
  ['número de troca repetido', 'repetido', (d) => { d.BASE.substituicoes[1].item = 1; return assina(d); }],
  ['usina com a designação antiga (M10)', 'usina fora', (d) => { d.BASE.substituicoes[3].parque = 'M10'; return assina(d); }],
  ['posição ilegível', 'posição', (d) => { d.BASE.substituicoes[0].ts = 'TS'; return assina(d); }],
  ['data que não existe', 'não é dia', (d) => { d.BASE.substituicoes[0].data = '2026-02-30'; return assina(d); }],
  ['quatro fusíveis', 'fora de 0 a 3', (d) => { d.BASE.substituicoes[4].fusiveisDanificados = 4; d.BASE.substituicoes[4].fases = 'L1/L2/L3/L4'; return assina(d); }],
  ['fases a menos que os fusíveis', 'não batem', (d) => { d.BASE.substituicoes[1].fases = 'L1'; return assina(d); }],
  ['fase repetida', 'não batem', (d) => { d.BASE.substituicoes[1].fases = 'L1/L1'; return assina(d); }],
  ['fase sem fusível', 'sem fusível', (d) => { d.BASE.substituicoes[0].fases = 'L1'; return assina(d); }],
  ['tipo do inversor instalado em português', 'tipo do inversor', (d) => { d.BASE.substituicoes[0].origem = 'Novo'; return assina(d); }],
  ['catálogo de códigos cortado', 'catálogo', (d) => { d.BASE.codigos.pop(); return assina(d, { linhas: false }); }],
  ['resumo do estoque que a lista desmente', 'resumo do estoque', (d) => { d.BASE.resumoAlmoxarifado.novos = 3; return assina(d); }],
  ['sem os movimentos de fusível', 'movimentos de fusível', (d) => { delete d.BASE.fusiveisMov; return assina(d); }],
  ['movimento sem data', 'movimento de fusível ilegível', (d) => { d.BASE.fusiveisMov[1].data = null; return assina(d); }],
  ['saldo de fusíveis que os movimentos desmentem', 'saldo de fusíveis', (d) => { d.BASE.resumoAlmoxarifado.fusiveis = 9; return assina(d); }],
  ['sem a hora do último lançamento', 'último lançamento', (d) => { d.META.modificadoEm = null; return assina(d); }],
  ['sem BASE e META', 'sem BASE', (d) => ({ BASE: d.BASE })],
];
// o dado sensível que chega à saída (pelo nome do código, que vai ao Pareto): a rodada tem de parar
const VAZAMENTOS = [
  ['série retirada', (d) => d.BASE.substituicoes[0].sn],
  ['série instalada', (d) => d.BASE.substituicoes[0].markup],
  ['série de estoque', (d) => d.BASE.estoqueSerie.novos[0].serie],
];

function julga(genPath) {
  const f = [], C = (ok, m) => { if (!ok) f.push(m); };
  delete require.cache[require.resolve(genPath)];
  const G = require(genPath);
  const D0 = sigoDeMentira();
  // 1-2. ponta a ponta
  const r = roda(genPath, D0);
  if (!r.ok) return ['o gerador recusou o arquivo bom: ' + r.log.slice(-300)];
  const o = r.o, p = o.p1, e = o.escopo.estoque;
  C(p.total === 8 && o.escopo.p1_registros === 8, 'trocas: ' + p.total + ' (devia 8; a planilha de falhas do contêiner tem 1 e não pode contar)');
  C(p.termico === 6 && p.termico_pct === 75, 'térmicas: ' + p.termico + ' / ' + p.termico_pct + '%');
  C(p.reposicao.com_ambas === 8 && p.reposicao.mesmo_dia === 5 && p.reposicao.max_dias === 2, 'reposição: ' + JSON.stringify(p.reposicao));
  const f2 = p.fatos.find((x) => x.local === 'M2/TS02/INV03') || {};
  C(f2.data === '2026-02-05' && f2.troca === '2026-02-07' && f2.dias_reposicao === 2, 'a troca nº 2 perdeu as datas: ' + JSON.stringify(f2));
  C(e.novo === 2 && e.reparado === 1 && e.fusivel === 8, 'estoque: ' + JSON.stringify(e));
  C(e.total === 3 && typeof e.cobertura_meses === 'number', 'cobertura do estoque sem conta');
  C(p.fusiveis.com_dano === 4 && p.fusiveis.fusiveis_total === 8 && p.fusiveis.avaliados === 8, 'fusíveis: ' + JSON.stringify(p.fusiveis));
  const fases = Object.fromEntries(p.fusiveis.por_fase.map((x) => [x.fase, x.n]));
  C(JSON.stringify(fases) === JSON.stringify({ L1: 3, L2: 3, L3: 2 }), 'fases: ' + JSON.stringify(p.fusiveis.por_fase));
  C(p.por_codigo[0] && p.por_codigo[0].codigo === '40' && p.por_codigo[0].n === 4 && p.por_codigo[0].nome === 'Falha do sistema / System fault', 'Pareto de códigos: ' + JSON.stringify(p.por_codigo[0]));
  C(p.com_codigo === 7 && p.fatos.filter((x) => x.codigo === '(sem código)').length === 1, 'troca sem código mal contada');
  C(JSON.stringify(p.por_origem) === JSON.stringify([{ origem: 'Novo', n: 7 }, { origem: 'Reparado', n: 1 }]), 'novo × reparado: ' + JSON.stringify(p.por_origem));
  C(p.por_parque.map((x) => x.parque).join() === 'M1,M2,M6,M7,M8,M9' && (p.por_parque.find((x) => x.parque === 'M8') || {}).n === 1, 'usinas: ' + JSON.stringify(p.por_parque.map((x) => x.parque + ':' + x.n)));
  C(o.fontes.substituicoes_planilha_em === '2026-11-20T13:00:00.000Z', 'hora do selo (BRT → UTC): ' + o.fontes.substituicoes_planilha_em);
  C(o.fontes.substituicoes_ultima === '2026-11-02', 'última troca: ' + o.fontes.substituicoes_ultima);
  C(o.dicionario.fault_codes_lidos === 3 && o.dicionario.desc_map_lidas === 2, 'contagem do catálogo: ' + JSON.stringify(o.dicionario));
  C(JSON.stringify(o.estoque_sn) === JSON.stringify({ blocos: [{ grupo: 'INVERSORES NOVOS', n: 3, disponiveis: 2 }, { grupo: 'INVERSORES REPARADOS', n: 2, disponiveis: 1 }] }), 'estoque por série: ' + JSON.stringify(o.estoque_sn));
  C(o.p2 && o.p2.eventos >= 1, 'os alarmes sumiram');
  { const txt = JSON.stringify(o); const v = SENSIVEIS(D0).filter((x) => txt.includes(x)); C(!v.length, 'dado sensível na saída: ' + v[0]); }
  // o dia é o do calendário, em qualquer fuso do servidor (o Actions roda em UTC; um dia lido como meia-noite UTC recua um dia no Brasil)
  { const b = roda(genPath, D0, { tz: 'America/Sao_Paulo' }); C(b.ok && JSON.stringify(b.o.p1.fatos) === JSON.stringify(p.fatos), 'as datas mudam com o fuso do servidor'); }
  { const g = roda(genPath, D0, { gz: true }); C(g.ok && JSON.stringify(g.o.p1) === JSON.stringify(p), 'o arquivo em gzip não dá o mesmo'); }
  // 3. o arquivo com defeito
  for (const [nome, trecho, planta] of DEFEITOS) {
    let msg = null; try { G.confereSigo(planta(copia(D0))); } catch (x) { msg = x.message; }
    C(msg && msg.includes(trecho), 'defeito aceito ou pego pela conferência errada · ' + nome + (msg ? ' · ' + msg.slice(0, 90) : ''));
  }
  { const x = roda(genPath, DEFEITOS[0][2](copia(D0))); C(!x.ok && /a origem não é o SIGO/.test(x.log), 'a rodada passou com a planilha no lugar do SIGO'); }
  { const x = roda(genPath, null, { bruto: JSON.stringify(D0).slice(0, 900) }); C(!x.ok, 'a rodada passou com o arquivo truncado'); }
  // 4. o dado sensível que chega à saída
  for (const [nome, valor] of VAZAMENTOS) {
    const d = copia(D0); d.BASE.codigos[1].nome = 'Falha ' + valor(d); assina(d);
    const x = roda(genPath, d); C(!x.ok && /EXPOSIÇÃO/.test(x.log), 'a ' + nome + ' chegou à saída sem parar a rodada');
  }
  return f;
}

const PLANTIOS = [
  ['aceita a planilha', "if (!/^SIGO\\b/.test(String(M.origem || '')))", "if (!/./.test(String(M.origem || '')))"],
  ['não confere a impressão digital', 'if (shaBase(B) !== M.sha256_16)', 'if (false)'],
  ['não confere a contagem de trocas', 'if (S.length !== L.substituicoes)', 'if (false)'],
  ['número repetido passa', 'if (vistos.has(s.item))', 'if (false)'],
  ['usina fora passa', 'if (!USINAS.includes(s.parque))', 'if (false)'],
  ['fases não conferidas', 'if (fa.length !== f || new Set(fa).size !== f || !fa.every((x) => FASES.includes(x)))', 'if (false)'],
  ['resumo do estoque não conferido', 'if (R.novos !== disp(E.novos) || R.reparados !== disp(E.reparados))', 'if (false)'],
  ['movimento ilegível passa', 'if (!diaLocal(x.data) || !inteiro(x.qtd) || x.qtd === 0)', 'if (false)'],
  ['saldo não conferido', 'if (!inteiro(R.fusiveis) || saldo !== R.fusiveis)', 'if (!inteiro(R.fusiveis))'],
  ['saldo a partir da troca nº 170', 'const ITEM_INI_SALDO = 166;', 'const ITEM_INI_SALDO = 170;'],
  ['a fase "0" volta', 'fases: fusQtd > 0 ? String(s.fases)', 'fases: true ? String(s.fases)'],
  ['o fusível do estoque some', 'fusivel: R.fusiveis,', 'fusivel: null,'],
  ['data da falha no lugar da troca', 'sub: diaLocal(s.dataSubstituicao)', 'sub: diaLocal(s.data)'],
  ['tipo do instalado sem tradução', 'orig: normOrig(s.origem)', 'orig: norm(s.origem)'],
  ['data no fuso do servidor', 'const x = new Date(y, mo - 1, d);', 'const x = new Date(String(v));'],
  ['guarda sem a série instalada', "['sn', 'markup', 'chamado', 'rnc']", "['sn', 'chamado', 'rnc']"],
  ['guarda sem a série de estoque', 'const v = norm(x.serie);', "const v = '';"],
  ['hora do selo sem o fuso', "new Date(sigo.META.modificadoEm + '-03:00')", "new Date(sigo.META.modificadoEm + 'Z')"],
  ['a planilha de falhas volta a contar', "if (cls === 'P1') p1Ignorados++;", "if (cls === 'P1') { p1Ignorados++; sigo.BASE.substituicoes.push(Object.assign({}, sigo.BASE.substituicoes[0], { item: 99999 })); }"],
];

if (require.main === module) {
  PASTA.atual = montaPasta();
  let ruim = 0;
  try {
    const f0 = julga(GEN);
    if (f0.length) { f0.forEach((x) => console.log('  🔴 ' + x)); process.exit(1); }
    console.log('✅ o gerador real passa: ' + DEFEITOS.length + ' arquivos com defeito recusados, ' + VAZAMENTOS.length + ' vazamentos barrados');
    const SRC = fs.readFileSync(GEN, 'utf8');
    PLANTIOS.forEach(([nome, de, para], k) => {
      const n = SRC.split(de).length - 1;
      if (n !== 1) { console.log('🔴 PLANTIO INVÁLIDO (' + n + ' ocorrências do trecho): ' + nome); ruim++; return; }
      const arq = path.join(__dirname, '.gen-inversores-plantio-' + k + '.js');
      fs.writeFileSync(arq, SRC.replace(de, para));
      let f; try { f = julga(arq); } catch (x) { f = ['estourou: ' + x.message]; } finally { fs.rmSync(arq, { force: true }); }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 100) + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    });
  } finally { fs.rmSync(PASTA.atual.t0, { recursive: true, force: true }); }
  if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
  console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
}
module.exports = { sigoDeMentira, assina };
