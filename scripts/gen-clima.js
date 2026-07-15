/*
 * gen-clima.js — grava dados/clima.json a partir do Open-Meteo (Mauriti/CE).
 *
 * POR QUE: hoje os 5 cards de clima do Grafana chamam a API pública do Open-Meteo DIRETO,
 * pelo backend do Grafana Cloud (IP de saída COMPARTILHADO entre clientes) → estoura a cota
 * por-IP → 429 → "No data" nos 5 ao mesmo tempo. Trazendo pro nosso blob (como todo o resto),
 * a chamada externa acontece 1x por execução deste script, de um IP nosso, e o Grafana lê o
 * arquivo. Elimina a dependência externa em tempo de render.
 *
 * O blob já vem com ícone (Tabler), cor e descrição prontos, pra o card só renderizar.
 * Sem token (Open-Meteo é grátis, sem chave). Só usa DADOS_STORAGE para gravar.
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');

const CONTAINER = 'dados';
const LAT = -7.38, LON = -38.77;
const API = 'https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON
  + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,shortwave_radiation,wind_speed_10m,weather_code,is_day'
  + '&wind_speed_unit=ms&timezone=America/Fortaleza';   // vento em m/s + is_day (dia/noite)

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// Código WMO → {texto, ícone, cor}, ciente de DIA/NOITE. Âmbar=sol · índigo=lua/noite · cinza/azul=nuvem/chuva.
const LUA = '#8B9DFF';   // tom frio de noite
function wmo(code, isDay) {
  const c = +code;
  // céu limpo / predom. limpo: sol de dia, LUA de noite (o bug que o usuário pegou)
  if (c === 0) return isDay ? { txt: 'Céu limpo', icon: 'sun', cor: '#FFB020' } : { txt: 'Noite limpa', icon: 'moon', cor: LUA };
  if (c === 1) return isDay ? { txt: 'Predom. limpo', icon: 'sun', cor: '#FFB020' } : { txt: 'Noite limpa', icon: 'moon', cor: LUA };
  if (c === 2) return isDay ? { txt: 'Parc. nublado', icon: 'cloud-sun', cor: '#9AA4B2' } : { txt: 'Nuvens à noite', icon: 'cloud-moon', cor: '#9AA4B2' };
  if (c === 3) return { txt: 'Nublado', icon: 'cloud', cor: '#8B93A1' };
  if (c === 45 || c === 48) return { txt: 'Névoa', icon: 'fog', cor: '#8B93A1' };
  if (c >= 51 && c <= 57) return { txt: 'Garoa', icon: 'cloud-rain', cor: '#4C9AFF' };
  if (c >= 61 && c <= 67) return { txt: 'Chuva', icon: 'cloud-rain', cor: '#4C9AFF' };
  if (c >= 71 && c <= 77) return { txt: 'Neve', icon: 'snowflake', cor: '#BCD6FF' };
  if (c >= 80 && c <= 82) return { txt: 'Pancadas de chuva', icon: 'cloud-storm', cor: '#4C9AFF' };
  if (c >= 95) return { txt: 'Tempestade', icon: 'bolt', cor: '#E5484D' };
  return { txt: 'Indefinido', icon: 'cloud', cor: '#8B93A1' };
}

async function gerarClima(conn) {
  if (!conn) throw new Error('DADOS_STORAGE ausente');

  const j = await getJson(API);
  const c = j.current || {};
  const isDay = +c.is_day === 1;
  const w = wmo(c.weather_code, isDay);
  const nowBRT = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19);

  // cada métrica já com ícone/cor prontos. Irradiância: sol de dia (âmbar), LUA de noite (índigo).
  const metricas = [
    { chave: 'irradiancia', rotulo: 'Irradiância', valor: Math.round(c.shortwave_radiation || 0), unidade: 'W/m²', icon: isDay ? 'sun' : 'moon', cor: isDay ? '#FFB020' : LUA, destaque: isDay },
    { chave: 'temperatura', rotulo: 'Temperatura', valor: +(+c.temperature_2m).toFixed(1), unidade: '°C', icon: 'temperature', cor: '#E06C3F', sub: 'Sensação ' + Math.round(c.apparent_temperature) + '°' },
    { chave: 'nuvens', rotulo: 'Nuvens', valor: Math.round(c.cloud_cover || 0), unidade: '%', icon: 'cloud', cor: '#9AA4B2' },
    { chave: 'umidade', rotulo: 'Umidade', valor: Math.round(c.relative_humidity_2m || 0), unidade: '%', icon: 'droplet', cor: '#4C9AFF' },
    { chave: 'vento', rotulo: 'Vento', valor: +(+c.wind_speed_10m).toFixed(1), unidade: 'm/s', icon: 'wind', cor: '#9AA4B2' },
    { chave: 'condicao', rotulo: 'Condição', texto: w.txt, icon: w.icon, cor: w.cor },
  ];

  const out = {
    atualizado: nowBRT,
    fonte: 'Open-Meteo · Mauriti/CE',
    hora_dado: (c.time || '').replace('T', ' '),
    weather_code: c.weather_code, is_day: +c.is_day, condicao: w.txt, condicao_icon: w.icon, condicao_cor: w.cor,
    // campos planos (fáceis de ler por Stat nativo, se quiser)
    irradiancia: Math.round(c.shortwave_radiation || 0),
    temperatura: +(+c.temperature_2m).toFixed(1),
    sensacao: +(+c.apparent_temperature).toFixed(1),
    umidade: Math.round(c.relative_humidity_2m || 0),
    nuvens: Math.round(c.cloud_cover || 0),
    vento: +(+c.wind_speed_10m).toFixed(1),
    metricas,   // <- o card Business Text itera aqui
  };

  const json = JSON.stringify(out);
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  await cont.getBlockBlobClient('clima.json').upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=120' } });

  console.log('clima.json OK · ' + nowBRT + ' · ' + w.txt
    + ' · ' + out.temperatura + '°C · irr ' + out.irradiancia + ' W/m² · umid ' + out.umidade + '% · ' + (json.length) + ' B');
  return out;
}

module.exports = { gerarClima };

// roda standalone (node scripts/gen-clima.js) OU é chamado pelo gen-way2-recent (a cada 5 min)
if (require.main === module) {
  gerarClima(process.env.DADOS_STORAGE).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
