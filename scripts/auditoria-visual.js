/* auditoria-visual.js — varre TODOS os painéis de um dashboard e lista divergências do design system.
 * Programático: pega o que o olho não pega (cor fora do padrão, unidade faltando, decimals
 * inconsistentes, painel sem descrição, título fora de convenção). */
const fs = require('fs'), https = require('https');
const env = ((JSON.parse(fs.readFileSync('C:/Users/user/OneDrive - rbenergy.com.br/PWC/ID_Indicador de Desempenho/.mcp.json', 'utf8')).mcpServers || {}).grafana || {}).env || {};
const BASE = (env.GRAFANA_URL || '').replace(/\/+$/, '');
const TOKEN = /^\$\{/.test(env.GRAFANA_SERVICE_ACCOUNT_TOKEN || '') ? process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN : env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
const UID = process.argv[2] || 'execmt1';
function api(p) { return new Promise((res, rej) => { const u = new URL(BASE + p);
  https.request({ hostname: u.hostname, path: u.pathname, headers: { Authorization: 'Bearer ' + TOKEN }, timeout: 60000 },
    x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res(JSON.parse(s))); }).on('error', rej).end(); }); }

// ---- DESIGN SYSTEM (as cores medidas e aprovadas) ----
const SISTEMA = {
  '#2E5845': 'verde fill (positivo/entregue)', '#43966B': 'verde acento',
  '#703B3F': 'vermelho fill (negativo/cortado)', '#C85C60': 'vermelho acento',
  '#48668E': 'azul fill (neutro/medição)', '#5C86BE': 'azul acento',
  '#5C462C': 'âmbar fill (meta/comissionamento)',
  '#F5A623': 'âmbar destaque/meta',
  '#525C6B': 'cinza neutro', '#8B93A1': 'texto secundário', '#F2F4F7': 'texto primário',
  '#5F6672': 'texto terciário', '#333841': 'borda', '#14161A': 'fundo card',
  '#23262C': 'divisor', '#131519': 'fundo alt', '#E0B050': 'irradiância',
  '#9AA4B2': 'meta tracejada', '#7FC49C': 'verde claro (label projeção)',
  '#C08A45': 'âmbar escuro (categórica #3)', '#4E9A98': 'teal (categórica #5)',
  '#FFD98A': 'fim do gradiente do título', '#1E3A2D': 'fill projeção', '#8B6B6B': 'série estimada',
  '#F7D9A6': 'texto sobre fill âmbar', '#454A52': 'texto inativo (seletor idioma)',
};
const norm = h => String(h).toUpperCase().replace(/^#?/, '#');

(async () => {
  const o = await api('/api/dashboards/uid/' + UID);
  const d = o.dashboard;
  console.log('='.repeat(78));
  console.log('AUDITORIA · ' + d.title + '  (uid ' + UID + ' · v' + o.meta.version + ')');
  console.log('='.repeat(78));

  const paineis = d.panels.filter(p => p.type !== 'row');
  const rows = d.panels.filter(p => p.type === 'row');
  console.log(`\n${paineis.length} painéis + ${rows.length} seções\n`);

  const achados = [];
  const add = (sev, pid, tit, o_) => achados.push({ sev, pid, tit, o: o_ });

  for (const p of paineis) {
    const t = (p.title || '').trim();
    const isTexto = /text|dynamictext/.test(p.type);

    // 1) DESCRIÇÃO — a convenção do projeto exige fórmula+fonte em cada card
    if (!isTexto && !(p.description || '').trim())
      add('ALTA', p.id, t, 'sem descrição (a convenção do projeto pede fórmula + fonte)');

    // 2) CORES fora do sistema
    const cores = [...new Set((JSON.stringify(p.fieldConfig || {}) + JSON.stringify(p.options || {}))
      .match(/#[0-9A-Fa-f]{6}/g) || [])].map(norm);
    const fora = cores.filter(c => !SISTEMA[c]);
    if (fora.length) add('MEDIA', p.id, t, 'cor fora do sistema: ' + fora.join(' '));

    // 3) UNIDADE ausente em painel numérico
    if (!isTexto && p.fieldConfig && p.fieldConfig.defaults) {
      const fd = p.fieldConfig.defaults;
      if (!fd.unit && !/table|piechart/.test(p.type))
        add('MEDIA', p.id, t, 'sem unidade definida (eixo/valor sai sem grandeza)');
      if (fd.decimals == null && !/table/.test(p.type))
        add('BAIXA', p.id, t, 'decimals não fixado (arredondamento varia com o valor)');
    }

    // 4) TÍTULO — convenção: contexto + variável
    if (!isTexto && t && !/\$ufv|\$mes|\$dia|—|·/.test(t))
      add('BAIXA', p.id, t, 'título sem contexto (não diz usina/mês nem usa separador do padrão)');

    // 5) LEGENDA visível com série única (ruído)
    if (p.options && p.options.legend && p.options.legend.showLegend && (p.targets || []).length === 1
        && ((p.targets[0].columns || []).length <= 2))
      add('BAIXA', p.id, t, 'legenda ligada com série única (o título já nomeia)');
  }

  // ---- relatório ----
  const ordem = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
  achados.sort((a, b) => ordem[a.sev] - ordem[b.sev] || a.pid - b.pid);
  const cont = { ALTA: 0, MEDIA: 0, BAIXA: 0 };
  achados.forEach(a => cont[a.sev]++);
  console.log(`ACHADOS: ${achados.length}  (alta ${cont.ALTA} · média ${cont.MEDIA} · baixa ${cont.BAIXA})\n`);
  let sev = '';
  for (const a of achados) {
    if (a.sev !== sev) { sev = a.sev; console.log('\n--- ' + sev + ' ---'); }
    console.log(`  [${a.pid}] ${(a.tit || '(sem título)').slice(0, 42).padEnd(44)} ${a.o}`);
  }
  // inventário de cores
  const todas = {};
  paineis.forEach(p => ((JSON.stringify(p.fieldConfig || {}) + JSON.stringify(p.options || {}))
    .match(/#[0-9A-Fa-f]{6}/g) || []).forEach(c => { const k = norm(c); todas[k] = (todas[k] || 0) + 1; }));
  console.log('\n\n--- INVENTÁRIO DE CORES (uso × painéis) ---');
  Object.entries(todas).sort((a, b) => b[1] - a[1]).forEach(([c, n]) =>
    console.log(`  ${c} ×${String(n).padEnd(3)} ${SISTEMA[c] || '<<< FORA DO SISTEMA'}`));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
