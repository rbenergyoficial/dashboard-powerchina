/*
 * gen-custos.js — custos do Azure do SIGO para a aba "Custos" da Malha do SIGO Dados (lote malha-custos, 09/11/2026).
 * Humano, 09/11/2026: "quero um painel no SIGO para medir os custos em tempo real (...) pode ser na Malha" e "meta de R$ 250 por mês".
 *
 * Duas camadas, porque a fatura do Azure chega com 8 a 24 h de atraso (limite do Azure, não deste gerador):
 *   oficial   — Cost Management (consulta de custo real, BRL, sem imposto), por dia e por serviço, mês corrente e anterior
 *   estimado  — hoje: os custos fixos pela média dos últimos dias completos + a saída de dados de hoje pela métrica Egress do
 *               storage (atualiza a cada hora), convertida pelo preço efetivo de um dia completo (custo de saída ÷ GB)
 * Avisos de mudança que custam caro (o banco de ensaio em S2 de 06/11 teria aparecido no mesmo dia).
 *
 * Grava portal-admin/custos.json (contêiner só do admin). Não lê nada de `dados`: as consultas vão à API de gestão do Azure,
 * que não é saída do storage. Token de gestão pelo az logado (o azure/login do job; no PC, o az do humano).
 *   LOCAL_OUT=<arquivo>   grava em disco e não sobe (ensaio)
 */
'use strict';
const https = require('https');
const fs = require('fs');
const { execFileSync } = require('child_process');

const META_MENSAL = 250;          // humano, 09/11/2026: "meta de R$ 250 por mês" (comparada ao valor COM imposto, o que ele paga)
const IMPOSTO = 0.1383;           // imposto da fatura de set/2026 (G190312670): R$ 123,49 sobre R$ 892,90
const BRT = -3 * 3600e3;
// os cortes da auditoria de 09/11/2026: a aba mostra o custo por dia do item antes e depois
const LOTES = [
  { id: 'banco-ensaio-s0', data: '2026-11-09', texto: 'Banco de ensaio do Gestão de S2 para S0', medidor: /^S[0-9] DTUs/, recurso: /sidd-gestao-ensaio$/i },
  { id: 'relogio-um-temporizador', data: '2026-11-09', texto: 'Relógio com um temporizador só', medidor: /Read Operations|Other Operations/, recurso: /relogiofunc$/i },
  { id: 'custo-way2agg-estado', data: null, texto: 'Agregados da Way2 pela cópia compactada (aguarda PROMOVER)', medidor: null, recurso: null },
  { id: 'ponte-disco-32', data: null, texto: 'Disco da ponte de 64 para 32 GB (aguarda PROMOVER)', medidor: /LRS Disk$/, recurso: /vm-ponte_osdisk|vm-ponte-os32/i }
];

function token() {
  const win = process.platform === 'win32';
  return execFileSync(win ? 'az.cmd' : 'az', ['account', 'get-access-token', '--resource', 'https://management.azure.com', '--query', 'accessToken', '-o', 'tsv'],
    { encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
let TK = null;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function pede(metodo, caminho, corpo) {
  const dado = corpo ? JSON.stringify(corpo) : null;
  return new Promise((ok, erro) => {
    const req = https.request({ hostname: 'management.azure.com', path: caminho, method: metodo, timeout: 60000,
      headers: Object.assign({ Authorization: 'Bearer ' + TK }, dado ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dado) } : {}) }, (r) => {
      const p = []; r.on('data', (c) => p.push(c));
      r.on('end', () => ok({ status: r.statusCode, depois: +r.headers['retry-after'] || +r.headers['x-ms-ratelimit-microsoft.costmanagement-entity-retry-after'] || 0, corpo: Buffer.concat(p).toString('utf8') }));
    });
    req.on('error', erro); req.on('timeout', () => req.destroy(new Error('timeout ' + caminho.split('?')[0])));
    if (dado) req.write(dado); req.end();
  });
}
async function api(metodo, caminho, corpo) {
  for (let i = 0; i < 6; i++) {
    const r = await pede(metodo, caminho, corpo);
    if (r.status === 429 || r.status >= 500) { await espera(Math.min(60, Math.max(r.depois, 10 * (i + 1))) * 1000); continue; }
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + caminho.split('?')[0] + ': ' + r.corpo.slice(0, 160));
    return JSON.parse(r.corpo);
  }
  throw new Error('limite de pedidos do Azure: ' + caminho.split('?')[0]);
}

const dia = (ms) => new Date(ms + BRT).toISOString().slice(0, 10);   // dia em BRT
const r2 = (x) => Math.round(x * 100) / 100;

async function custo(S, de, ate, agrupa) {
  const j = await api('POST', `/subscriptions/${S}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`, {
    type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: de + 'T00:00:00Z', to: ate + 'T23:59:59Z' },
    dataset: { granularity: agrupa.diario ? 'Daily' : 'None', aggregation: { c: { name: 'Cost', function: 'Sum' } },
      grouping: agrupa.por.map((n) => ({ type: 'Dimension', name: n })) } });
  const cols = j.properties.columns.map((c) => c.name);
  return j.properties.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}
const diaCusto = (v) => { const s = String(v); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); };

async function egressGB(S, deMs, ateMs) {
  const id = `/subscriptions/${S}/resourceGroups/rg-dashboard/providers/Microsoft.Storage/storageAccounts/rbenergydata/blobServices/default`;
  const t = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const j = await api('GET', `${id}/providers/Microsoft.Insights/metrics?api-version=2023-10-01&metricnames=Egress&interval=PT1H&aggregation=Total&timespan=${t(deMs)}/${t(ateMs)}`);
  const s = ((j.value[0] || {}).timeseries || [])[0];
  return s ? s.data.reduce((a, d) => a + (d.total || 0), 0) / 1e9 : 0;
}

async function main() {
  TK = token();
  const subs = (await api('GET', '/subscriptions?api-version=2022-12-01')).value;
  if (subs.length !== 1) throw new Error('esperava uma assinatura visível, há ' + subs.length);
  const S = subs[0].subscriptionId;
  const agora = Date.now(), hoje = dia(agora);
  const [ano, mes] = hoje.split('-').map(Number);
  const ini = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const diasMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const antIni = new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 10);
  const antFim = new Date(Date.UTC(ano, mes - 1, 0)).toISOString().slice(0, 10);

  // 1. oficial: por dia e serviço (mês corrente e anterior) e por recurso e medidor (mês corrente)
  const linhas = await custo(S, antIni, hoje, { diario: true, por: ['ServiceName'] });
  const porDia = new Map();
  for (const l of linhas) {
    const d = diaCusto(l.UsageDate); const m = porDia.get(d) || {}; m[l.ServiceName] = (m[l.ServiceName] || 0) + l.Cost; porDia.set(d, m);
  }
  const serie = [...porDia.entries()].sort().map(([d, m]) => ({ dia: d, total: r2(Object.values(m).reduce((a, b) => a + b, 0)),
    servicos: Object.fromEntries(Object.entries(m).filter(([, v]) => v >= 0.005).map(([k, v]) => [k, r2(v)])) }));
  const doMes = serie.filter((x) => x.dia >= ini);
  const doAnt = serie.filter((x) => x.dia >= antIni && x.dia <= antFim);
  const recursos = await custo(S, ini, hoje, { diario: false, por: ['ResourceId', 'Meter'] });
  const recursosDia = await custo(S, dia(agora - 20 * 86400e3), hoje, { diario: true, por: ['ResourceId', 'Meter'] });

  // dias completos: o último dia com dado pode estar parcial (a fatura chega aos pedaços); conta como completo até anteontem
  const completo = dia(agora - 2 * 86400e3);
  const completos = doMes.concat(doAnt).filter((x) => x.dia <= completo).sort((a, b) => a.dia.localeCompare(b.dia));
  const ult7 = completos.slice(-7);
  const ritmo = ult7.length ? ult7.reduce((a, x) => a + x.total, 0) / ult7.length : 0;
  const gastoMes = doMes.reduce((a, x) => a + x.total, 0);
  const ultimoComDado = doMes.length ? doMes[doMes.length - 1].dia : null;
  const diasComDado = ultimoComDado ? Number(ultimoComDado.slice(8)) : 0;
  const previsao = gastoMes + ritmo * (diasMes - diasComDado);

  // 2. estimado de hoje: fixos (tudo menos a saída) pela média dos 3 últimos dias completos + a saída de hoje pela métrica
  const ult3 = completos.slice(-3);
  const fixos = ult3.length ? ult3.reduce((a, x) => a + x.total - (x.servicos.Bandwidth || 0), 0) / ult3.length : 0;
  const dRef = ult3.length ? ult3[ult3.length - 1] : null;
  let preco = 0.78, gbRef = null;
  if (dRef) {
    const i0 = Date.parse(dRef.dia + 'T03:00:00Z');
    gbRef = await egressGB(S, i0, i0 + 86400e3);
    if (gbRef > 0.5 && dRef.servicos.Bandwidth) preco = dRef.servicos.Bandwidth / gbRef;   // inclui a parte que não é cobrada (Brasil)
  }
  const inicioHoje = Date.parse(hoje + 'T03:00:00Z');
  const gbHoje = await egressGB(S, inicioHoje, agora);
  const horas = Math.max(1, (agora - inicioHoje) / 3600e3);
  const saidaHoje = gbHoje * preco, saidaDia = saidaHoje * 24 / horas;

  // 3. avisos de mudança que custa caro (cada um com o porquê)
  const avisos = [];
  const sqls = await api('GET', `/subscriptions/${S}/providers/Microsoft.Sql/servers?api-version=2021-11-01`);
  for (const sv of sqls.value) {
    const dbs = await api('GET', `${sv.id}/databases?api-version=2021-11-01`);
    for (const db of dbs.value) {
      if (db.name === 'master') continue;
      const sku = db.sku || {};
      if (sku.tier === 'Standard' && sku.capacity > 10) avisos.push({ tipo: 'banco', grau: 'alto', texto: `Banco ${db.name} em ${sku.name} (${sku.capacity} DTU): acima do S0 combinado em 09/11` });
      if (/Premium|BusinessCritical|Hyperscale/i.test(sku.tier || '')) avisos.push({ tipo: 'banco', grau: 'alto', texto: `Banco ${db.name} no nível ${sku.tier}` });
    }
  }
  const discos = await api('GET', `/subscriptions/${S}/providers/Microsoft.Compute/disks?api-version=2023-04-02`);
  for (const d of discos.value) {
    if (d.properties.diskState === 'Unattached') avisos.push({ tipo: 'disco', grau: 'medio', texto: `Disco ${d.name} (${d.properties.diskSizeGB} GB) solto, sem máquina: continua cobrado` });
  }
  const vm = await api('GET', `/subscriptions/${S}/resourceGroups/rg-ponte-mauriti/providers/Microsoft.Compute/virtualMachines/vm-ponte/instanceView?api-version=2024-07-01`);
  const ligada = (vm.statuses || []).some((s) => s.code === 'PowerState/running');
  const hm = new Date(agora + BRT).toISOString().slice(11, 16);
  if (ligada && (hm < '05:40' || hm > '12:30')) avisos.push({ tipo: 'ponte', grau: 'medio', texto: `A ponte está ligada às ${hm}, fora da janela da manhã (05:40–12:30): R$ 0,67 por hora` });
  const saida7 = ult7.length ? ult7.reduce((a, x) => a + (x.servicos.Bandwidth || 0), 0) / ult7.length : 0;
  if (horas >= 4 && saida7 > 0 && saidaDia > 2 * saida7) avisos.push({ tipo: 'saida', grau: 'alto', texto: `Saída de dados de hoje no ritmo de R$ ${r2(saidaDia)} no dia, mais que o dobro da média (R$ ${r2(saida7)})` });
  if (previsao * (1 + IMPOSTO) > META_MENSAL) avisos.push({ tipo: 'meta', grau: 'alto', texto: `Previsão do mês com imposto R$ ${r2(previsao * (1 + IMPOSTO))}, acima da meta de R$ ${META_MENSAL}` });

  // 4. os lotes da auditoria: custo por dia do item nos 7 dias antes e depois da data
  const lotes = LOTES.map((l) => {
    if (!l.data || !l.medidor) return { id: l.id, texto: l.texto, data: l.data, antes_dia: null, depois_dia: null };
    const casa = recursosDia.filter((x) => l.medidor.test(x.Meter) && l.recurso.test(x.ResourceId));
    const media = (f) => { const ds = new Map(); for (const x of casa) { const d = diaCusto(x.UsageDate); if (f(d)) ds.set(d, (ds.get(d) || 0) + x.Cost); }
      const v = [...ds.entries()].filter(([d]) => d <= completo).map(([, c]) => c); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const tres = dia(Date.parse(l.data + 'T12:00:00Z') - 3 * 86400e3 - BRT);   // antes = os 3 dias anteriores à data; depois = os dias completos após
    return { id: l.id, texto: l.texto, data: l.data, antes_dia: media((d) => d < l.data && d >= tres), depois_dia: media((d) => d > l.data) };
  });

  const top = recursos.map((x) => ({ recurso: String(x.ResourceId).split('/').pop(), medidor: x.Meter, custo: r2(x.Cost) }))
    .filter((x) => x.custo >= 0.5).sort((a, b) => b.custo - a.custo).slice(0, 10);
  const servMes = {}, servAnt = {};
  for (const x of doMes) for (const [k, v] of Object.entries(x.servicos)) servMes[k] = r2((servMes[k] || 0) + v);
  for (const x of doAnt) if (Number(x.dia.slice(8)) <= diasComDado) for (const [k, v] of Object.entries(x.servicos)) servAnt[k] = r2((servAnt[k] || 0) + v);

  const out = {
    gerado_em: new Date(agora).toISOString(), ms: agora, moeda: 'BRL', imposto: IMPOSTO,
    meta: { mensal: META_MENSAL, diaria: r2(META_MENSAL / diasMes), base: 'com imposto' },
    mes: { inicio: ini, dias: diasMes, ultimo_dia_com_dado: ultimoComDado, gasto: r2(gastoMes), gasto_com_imposto: r2(gastoMes * (1 + IMPOSTO)),
      previsao: r2(previsao), previsao_com_imposto: r2(previsao * (1 + IMPOSTO)), ritmo_diario_7d: r2(ritmo) },
    hoje: { dia: hoje, horas: r2(horas), fixos_dia: r2(fixos), saida_gb: r2(gbHoje), preco_gb: r2(preco), saida_ate_agora: r2(saidaHoje),
      estimado_dia: r2(fixos + saidaDia), estimado_dia_com_imposto: r2((fixos + saidaDia) * (1 + IMPOSTO)) },
    por_dia: doMes, mes_anterior: { inicio: antIni, fim: antFim, total: r2(doAnt.reduce((a, x) => a + x.total, 0)), por_dia: doAnt },
    servicos: Object.keys(Object.assign({}, servMes, servAnt)).map((k) => ({ servico: k, mes: servMes[k] || 0, mes_anterior_mesmo_periodo: servAnt[k] || 0 }))
      .sort((a, b) => b.mes - a.mes),
    top_recursos: top, avisos, lotes
  };
  // grava em disco SEMPRE; quem sobe é o passo seguinte (SOBE=<arquivo>), depois do ensaio do arquivo
  const arq = process.env.LOCAL_OUT || 'custos.json';
  fs.writeFileSync(arq, JSON.stringify(out));
  console.log('gravado em disco: ' + arq);
  console.log(`mês ${ini}: R$ ${out.mes.gasto} até ${ultimoComDado} · previsão R$ ${out.mes.previsao} (c/ imposto ${out.mes.previsao_com_imposto}) · meta ${META_MENSAL}`);
  console.log(`hoje: ${out.hoje.saida_gb} GB de saída · estimado R$ ${out.hoje.estimado_dia} · ${avisos.length} aviso(s)`);
  return out;
}

async function sobe(arq) {
  const txt = fs.readFileSync(arq, 'utf8'); JSON.parse(txt);
  await require('./lib-conteiner').conteiner('portal-admin').getBlockBlobClient('custos.json')
    .upload(txt, Buffer.byteLength(txt), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-cache' } });
  console.log('portal-admin/custos.json gravado (' + txt.length + ' bytes)');
}

if (require.main === module) (process.env.SOBE ? sobe(process.env.SOBE) : main()).catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
module.exports = { main, LOTES, META_MENSAL, IMPOSTO };
