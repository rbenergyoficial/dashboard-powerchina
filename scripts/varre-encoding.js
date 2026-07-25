/* varre-fffd.js — procura U+FFFD (replacement char) em TODOS os dashboards.
 * CAUSA DA CORRUPÇÃO: helper HTTP que fazia `s += chunk` — concatenar Buffer como string quebra
 * caracteres multi-byte (—, ç, ã…) que caem na fronteira entre dois chunks TCP.
 * CORRETO: acumular Buffers e só então toString('utf8') — é o que este script faz. */
const fs = require('fs'), https = require('https');
const env = ((JSON.parse(fs.readFileSync('C:/Users/user/OneDrive - rbenergy.com.br/PWC/ID_Indicador de Desempenho/.mcp.json', 'utf8')).mcpServers || {}).grafana || {}).env || {};
const BASE = (env.GRAFANA_URL || '').replace(/\/+$/, '');
const TOKEN = /^\$\{/.test(env.GRAFANA_SERVICE_ACCOUNT_TOKEN || '') ? process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN : env.GRAFANA_SERVICE_ACCOUNT_TOKEN;

// helper CORRETO: Buffer.concat antes de decodificar
function api(m, p, b) { return new Promise((res, rej) => { const u = new URL(BASE + p);
  const d = b ? Buffer.from(JSON.stringify(b), 'utf8') : null;
  const r = https.request({ hostname: u.hostname, path: u.pathname, method: m,
    headers: Object.assign({ Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
      d ? { 'Content-Length': d.length } : {}), timeout: 90000 },
    x => { const ch = []; x.on('data', c => ch.push(c));
      x.on('end', () => { const t = Buffer.concat(ch).toString('utf8');
        x.statusCode >= 300 ? rej(new Error(x.statusCode + ' ' + t.slice(0, 250))) : res(JSON.parse(t)); }); });
  r.on('error', rej); if (d) r.write(d); r.end(); }); }

const DASHES = ['execmt1','adfmd6','perfmt1','ppaml1','a75gd7','rbb7ggq','a88bwp','asldtr','invmt1',
  'mon230kv','mon345kv','adfmd6en','adfmd6zh'];

(async () => {
  let total = 0;
  for (const uid of DASHES) {
    let o; try { o = await api('GET', '/api/dashboards/uid/' + uid); } catch (e) { console.log(uid + ': ' + e.message.slice(0,60)); continue; }
    const achados = [];
    const scan = (obj, caminho) => {
      if (typeof obj === 'string') { if (obj.includes('\uFFFD')) achados.push([caminho, obj.slice(0, 90)]); return; }
      if (Array.isArray(obj)) return obj.forEach((v, i) => scan(v, caminho + '[' + i + ']'));
      if (obj && typeof obj === 'object') return Object.keys(obj).forEach(k => scan(obj[k], caminho + '.' + k));
    };
    (o.dashboard.panels || []).forEach(p => scan({ title: p.title, description: p.description,
      options: p.options }, 'painel[' + p.id + ']'));
    scan(o.dashboard.templating || {}, 'templating');
    if (achados.length) {
      console.log('\n### ' + uid + ' (v' + o.meta.version + ') — ' + achados.length + ' string(s) corrompida(s):');
      achados.slice(0, 12).forEach(([c, t]) => console.log('   ' + c + '\n      "' + t + '"'));
      if (achados.length > 12) console.log('   ... e mais ' + (achados.length - 12));
      total += achados.length;
    } else console.log(uid + ' · limpo');
  }
  console.log('\nTOTAL de strings corrompidas: ' + total);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
