'use strict';
/*
 * ensaio-lib-conteiner.js — prova a porta única para o storage (lib-conteiner.js, plano OIDC etapa 2, 25/10/2026).
 *
 * Sem segredo e sem a rede de fora: o storage, o GitHub e o Entra são um servidor https local (certificado de um dia, feito com o
 * openssl); nos casos da troca o transporte da lib é simulado, e o transporte de verdade é julgado à parte contra o servidor local.
 * A suíte roda num processo filho, com as variáveis de cada caso, e o pai exige que ela chegue ao FIM com todos os casos.
 *   1. a chave (DADOS_STORAGE): o cliente sai da cadeia de conexão e o storage recebe a assinatura de chave compartilhada (SharedKey),
 *      como sempre foi;
 *   2. sem credencial, com o OIDC pela metade ou com variável só de espaço: estoura, nomeando exatamente o que falta. Gravar sem
 *      credencial nunca vira "não gravou nada";
 *   3. a chave e o OIDC juntos: vence a chave. Enquanto um workflow tiver o segredo, nada muda para ele;
 *   4. a troca do OIDC: o pedido ao GitHub leva o audience do Entra e o token do job; o pedido ao Entra leva o cliente, o escopo do
 *      storage e a asserção que o GitHub devolveu;
 *   5. o token fica guardado enquanto faltar mais de 5 min para vencer e é trocado de novo a 5 min do fim (dos dois lados da borda,
 *      54:59 e 55:01 de um token de 60 min); dois contêineres usam o mesmo token;
 *   6. de ponta a ponta pelo SDK: a lib-le-dados, sem DADOS_STORAGE nem DADOS_SAS e com o OIDC, lê pelo SDK (modo 'sdk') e o servidor
 *      recebe o token de acesso no cabeçalho; uma gravação pelo contêiner da lib-conteiner também; o 404 continua "não existe";
 *   7. as leituras de sempre: com a DADOS_SAS e sem o OIDC, modo 'sas'; sem nada, 'publico'; o OIDC com a DADOS_SAS, 'sdk' (a ordem
 *      que a lib-le-dados declara);
 *   8. o transporte de verdade da troca: o erro do Entra chega com o status e o corpo (o AADSTS); servidor mudo estoura por tempo;
 *      resposta 200 que não é JSON rejeita, sem derrubar o processo; e o Entra sem `expires_in` é recusado;
 *   9. os geradores que já migraram (MIGRADOS), de verdade, num processo à parte: gravam pelo OIDC, e o storage recebe o token.
 * A FIAÇÃO dos workflows migrados (no pai, sobre o texto): sem `secrets.DADOS_STORAGE`, com `id-token: write` e `contents: read`, com
 * AZURE_CLIENT_ID e AZURE_TENANT_ID das variáveis do repo, nenhum `node scripts/` do workflow (nem as libs dele) dependendo da chave,
 * e cada gravador pela lib-conteiner. A fiação plantada (a chave de volta, sem o id-token, o gerador pela cadeia de conexão) reprova.
 * PLANTIOS (cada um TEM de reprovar a suíte, com a mensagem do caso certo e sem erro de sintaxe): a lib-le-dados que só conhece a
 * chave; o OIDC que vence a chave; o token pedido de novo a cada chamada; o token que nunca se renova; o transporte que esquece o
 * status; o transporte sem tempo esgotado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const LIBS = ['lib-conteiner.js', 'lib-le-dados.js'];
const MODULOS = path.join(__dirname, '..', 'node_modules');
const CASOS = 28;   // a suíte inteira; menos que isto é suíte que parou no meio, mesmo com código 0
/* os workflows que já gravam sem a chave e, de cada um, os gravadores (abrem o storage pela lib-conteiner) com o env do ensaio de
   ponta a ponta (caso 9). null = só a fiação: o gerador depende de rede de fora (a API da Way2, o ONS) ou do arquivo do SAGER. */
const MIGRADOS = {
  'oleo.yml': { 'gen-oleo.js': { OUT_CONTAINER: 'dados', OUT_BLOB: 'oleo-ensaio.json' } },   // etapa 3, piloto
  'must.yml': { 'gen-must.js': null },                                                         // etapa 4, os diários simples
  'irradiancia-ons.yml': { 'gen-irradiancia-ons.js': null },
  'sager-disp.yml': { 'gen-sager-disp.js': null },
};
/* a chave em qualquer das formas de lê-la: a cadeia de conexão, a credencial de chave, a variável por ponto, por colchete ou desestruturada */
const CHAVE_RE = /fromConnectionString|StorageSharedKeyCredential|process\.env(?:\.|\[\s*['"])DADOS_STORAGE|\{[^}]*\bDADOS_STORAGE\b[^}]*\}\s*=\s*process\.env/;
const TMPS = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-conteiner-')); TMPS.push(d); return d; };
const OIDC_FORA = { AZURE_CLIENT_ID: null, AZURE_TENANT_ID: null, ACTIONS_ID_TOKEN_REQUEST_URL: null, ACTIONS_ID_TOKEN_REQUEST_TOKEN: null };

if (process.argv[2] === '--suite') { suite(process.argv[3], process.argv[4]).catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); }); return; }

/* as duas libs numa pasta à parte (a de verdade ou a plantada), com o SDK achado pelo NODE_PATH */
function pasta(troca) {
  const d = tmp();
  for (const f of LIBS) {
    let src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');
    if (troca && troca.arq === f) {
      if (src.split(troca.de).length !== 2) return null;
      src = src.split(troca.de).join(troca.para);
    }
    fs.writeFileSync(path.join(d, f), src);
  }
  return d;
}
function roda(dir, cert) {
  const e = Object.assign({}, process.env, OIDC_FORA, { DADOS_STORAGE: null, DADOS_SAS: null, DADOS_CONTA_URL: null, LE_DADOS_PROPRIOS: null,
    CACHE_BLOB_DIR: null, NODE_PATH: MODULOS, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' });
  for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
  // a suíte leva ~2 s: 30 s de teto deixa os 7 filhos bem abaixo dos 10 min do job do ensaios.yml
  const r = spawnSync(process.execPath, [__filename, '--suite', dir, cert], { env: e, encoding: 'utf8', timeout: 30000 });
  return { cod: r.status, out: (r.stdout || '') + (r.stderr || '') + (r.error ? '\nFALHOU: ' + r.error.message : '') };
}

let falhas = 0;
const ok = (c, m) => { console.log((c ? '  ok · ' : '  REPROVADO · ') + m); if (!c) falhas++; };
try {
  if (!fs.existsSync(path.join(MODULOS, '@azure', 'storage-blob'))) throw new Error('falta o @azure/storage-blob em node_modules (npm i @azure/storage-blob@12)');
  const cert = tmp();
  const o = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', path.join(cert, 'chave.pem'), '-out', path.join(cert, 'cert.pem')], { encoding: 'utf8' });
  if (o.status !== 0 || !fs.existsSync(path.join(cert, 'cert.pem'))) throw new Error('openssl não gerou o certificado do servidor local: ' + (o.stderr || o.error || '').toString().slice(0, 200));

  console.log('as libs de verdade');
  const R = roda(pasta(null), cert);
  process.stdout.write(R.out.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n') + '\n');
  ok(R.cod === 0 && R.out.indexOf('suíte: ' + CASOS + ' casos ok') >= 0, 'a suíte chega ao fim com os ' + CASOS + ' casos, com a lib-conteiner e a lib-le-dados de verdade');

  console.log('a fiação dos workflows que já gravam sem a chave');
  const WF = (w) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', w), 'utf8').replace(/\r\n/g, '\n');
  const GEN = (g) => fs.readFileSync(path.join(__dirname, g), 'utf8').replace(/\r\n/g, '\n');
  for (const w of Object.keys(MIGRADOS)) {
    const prob = fiacao(WF(w), Object.keys(MIGRADOS[w]), GEN);
    ok(prob.length === 0, w + ': sem a chave, com o OIDC, e os geradores pela lib-conteiner' + (prob.length ? ' (' + prob.join('; ') + ')' : ''));
  }
  /* fiação plantada: [nome, workflow, troca no texto do workflow (de, para) ou null, arquivos trocados {arq: [de, para]}, o que tem de acusar] */
  const PLANTADAS = [
    ['a chave de volta no job', 'oleo.yml', ['      AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}\n',
      '      AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}\n      DADOS_STORAGE: ${{ secrets.DADOS_STORAGE }}\n'], {}, 'ainda cita secrets.DADOS_STORAGE'],
    ['sem o id-token', 'oleo.yml', ['      id-token: write\n', ''], {}, 'sem id-token: write'],
    ['sem o passo que falha fora do main', 'must.yml', ['            exit 1\n', ''], {}, 'sem o passo que falha fora do main'],
    ['o gerador pela cadeia de conexão', 'oleo.yml', null, { 'gen-oleo.js': ["require('./lib-conteiner').conteiner(OUT_CONTAINER)",
      "require('@azure/storage-blob').BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER)"] },
      'gen-oleo.js ainda depende da chave'],
    ['o gerador que não abre pela lib-conteiner', 'oleo.yml', null, { 'gen-oleo.js': ["require('./lib-conteiner').conteiner(OUT_CONTAINER)", 'null'] },
      'gen-oleo.js não abre pela lib-conteiner'],
    ['a lib de um gerador lendo a chave', 'sager-disp.yml', null, { 'lib-sager-disp.js': ["'use strict';", "'use strict';\nconst k = process.env['DADOS_STORAGE'];"] },
      'lib-sager-disp.js (alcançado por gen-sager-disp.js) ainda depende da chave'],
    ['um ensaio do workflow lendo a chave', 'sager-disp.yml', null, { 'ensaio-sager-disp.js': ["'use strict';", "'use strict';\nconst { DADOS_STORAGE } = process.env;"] },
      'ensaio-sager-disp.js ainda depende da chave'],
  ];
  for (const [nome, w, trWf, trArq, esperado] of PLANTADAS) {
    let wf = WF(w), casou = !trWf || wf.split(trWf[0]).length === 2;
    if (trWf) wf = wf.split(trWf[0]).join(trWf[1]);
    const texto = (g) => { const s = GEN(g); if (!trArq[g]) return s; if (s.split(trArq[g][0]).length < 2) casou = false; return s.replace(trArq[g][0], trArq[g][1]); };
    const prob = fiacao(wf, Object.keys(MIGRADOS[w]), texto);
    ok(casou && prob.some((x) => x.indexOf(esperado) >= 0), 'fiação plantada "' + nome + '" reprova em "' + esperado + '"'
      + (casou ? '' : ' (TRECHO NÃO CASOU)') + (prob.length ? '' : ' (nada acusado)'));
  }

  console.log('plantios (cada um reprova com a mensagem do caso certo)');
  const planta = (nome, arq, de, para, esperado) => {
    const d = pasta({ arq, de, para });
    if (!d) { ok(false, 'plantio "' + nome + '": trecho não casou'); return; }
    const x = roda(d, cert);
    const limpo = !/SyntaxError|Cannot find module|ETIMEDOUT|spawnSync/.test(x.out);
    ok(x.cod !== 0 && limpo && x.out.indexOf('FALHOU: ' + esperado) >= 0, 'plantio "' + nome + '" reprova em "' + esperado + '"'
      + (limpo ? '' : ' (QUEBROU: ' + x.out.split('\n').find((l) => /Error|FALHOU/.test(l)) + ')'));
  };
  planta('a lib-le-dados que só conhece a chave', 'lib-le-dados.js', "  if (require('./lib-conteiner').credencial()) return 'sdk';",
    "  if (process.env.DADOS_STORAGE) return 'sdk';", '6: a lib-le-dados com o OIDC lê pelo SDK');
  planta('o OIDC vence a chave', 'lib-conteiner.js', "  if (process.env.DADOS_STORAGE) return 'chave';\n  if (faltaOidc().length === 0) return 'oidc';",
    "  if (faltaOidc().length === 0) return 'oidc';\n  if (process.env.DADOS_STORAGE) return 'chave';", '3: a chave e o OIDC juntos');
  planta('o token pedido a cada chamada', 'lib-conteiner.js', '      if (atual && atual.expiresOnTimestamp - Date.now() > FOLGA_MS) return atual;\n', '',
    '5: o token fica guardado');
  planta('o token que nunca se renova', 'lib-conteiner.js', '      if (atual && atual.expiresOnTimestamp - Date.now() > FOLGA_MS) return atual;',
    '      if (atual) return atual;', '5: a 5 min do fim');
  planta('o transporte que esquece o status', 'lib-conteiner.js',
    "        if (res.statusCode >= 300) return ko(new Error('HTTP ' + res.statusCode + ' · ' + t.slice(0, 200)));   // o AADSTS do Entra vem aqui\n", '',
    '8: o erro do Entra chega com o status e o corpo');
  planta('o transporte sem tempo esgotado', 'lib-conteiner.js', "    r.on('timeout', () => r.destroy(new Error('tempo esgotado em ' + opts.hostname)));\n", '',
    '8: servidor mudo estoura por tempo');
  planta('a troca sem nova tentativa', 'lib-conteiner.js', '      if (i >= ESPERAS_MS.length || !passageiro(e)) throw e;', '      throw e;',
    '8: o 503 isolado do Entra passa na segunda tentativa');
  planta('nova tentativa até no erro de configuração', 'lib-conteiner.js', '  return m ? (+m[1] === 429 || +m[1] >= 500) : true;', '  return true;',
    '8: o AADSTS (400) estoura na primeira');
} catch (e) {
  console.log('  REPROVADO · ' + e.message); falhas++;
} finally {
  for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } }
}
console.log(falhas ? 'REPROVADO: ' + falhas + ' falha(s)' : 'APROVADO');
process.exit(falhas ? 1 : 0);

/* o que falta para um workflow gravar sem a chave; lista vazia = fiação certa */
function fiacao(wf, gens, texto) {
  const p = [];
  if (/secrets\.DADOS_STORAGE/.test(wf)) p.push('ainda cita secrets.DADOS_STORAGE');
  if (!/\n\s+id-token: write\n/.test(wf)) p.push('sem id-token: write');
  if (!/\n\s+contents: read\n/.test(wf)) p.push('sem contents: read (o permissions explícito zera o resto)');
  if (!/\n\s+AZURE_CLIENT_ID: \$\{\{ vars\.AZURE_CLIENT_ID \}\}\n/.test(wf)) p.push('sem AZURE_CLIENT_ID das variáveis do repo');
  if (!/\n\s+AZURE_TENANT_ID: \$\{\{ vars\.AZURE_TENANT_ID \}\}\n/.test(wf)) p.push('sem AZURE_TENANT_ID das variáveis do repo');
  // o primeiro passo falha fora do main (a credencial federada só vale para o main), pela variável de ambiente, nunca interpolada
  if (!/\n\s+if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then\n[^\n]*\n\s+exit 1\n/.test(wf)) p.push('sem o passo que falha fora do main');
  // todo script que o workflow roda, e tudo o que ele carrega de scripts/ (fechamento dos require locais, em qualquer profundidade),
  // sem a chave: sem ela no job, quem a exigir quebra. A lib-conteiner é a porta e fica de fora.
  for (const m of new Set([...wf.matchAll(/node scripts\/([\w.-]+\.js)/g)].map((x) => x[1]))) {
    const vistos = new Set(), fila = [m];
    while (fila.length) {
      const f = fila.shift();
      if (vistos.has(f) || f === 'lib-conteiner.js') continue;
      vistos.add(f);
      let t; try { t = texto(f); } catch (e) { continue; }   // módulo local que não é .js de scripts/ (um .json, por exemplo)
      if (CHAVE_RE.test(t)) p.push(f + (f === m ? '' : ' (alcançado por ' + m + ')') + ' ainda depende da chave');
      for (const x of t.matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) fila.push(x[1] + '.js');
    }
  }
  for (const g of gens) if (!/require\('\.\/lib-conteiner'\)\.conteiner\(/.test(texto(g))) p.push(g + ' não abre pela lib-conteiner');
  return p;
}

/* ---- a suíte, no processo filho ---------------------------------------------------------------------------------------------- */
async function suite(dir, cert) {
  let n = 0;
  const caso = (c, m) => { if (!c) throw new Error(m); n++; };
  const novo = () => { for (const f of LIBS) delete require.cache[require.resolve(path.join(dir, f))]; return require(path.join(dir, 'lib-conteiner.js')); };
  const limpa = () => { for (const k of ['DADOS_STORAGE', 'DADOS_SAS', 'DADOS_CONTA_URL', ...Object.keys(OIDC_FORA)]) delete process.env[k]; };
  const OIDC = { AZURE_CLIENT_ID: 'cliente-ensaio', AZURE_TENANT_ID: 'locatario-ensaio',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.exemplo.invalid/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'pedido-do-job' };
  const CHAVE_B64 = Buffer.from('chave-de-ensaio').toString('base64');
  const CHAVE = 'DefaultEndpointsProtocol=https;AccountName=contaensaio;AccountKey=' + CHAVE_B64 + ';EndpointSuffix=core.windows.net';
  /* o transporte simulado: o GitHub devolve a asserção, o Entra devolve o token de acesso (AT1, AT2…) */
  const pedidos = []; let emitidos = 0, validade = 3600;
  const transporte = async (opts, corpo) => {
    pedidos.push({ opts, corpo });
    if (opts.hostname === 'gh.exemplo.invalid') return { value: 'assercao-' + (emitidos + 1) };
    if (opts.hostname === 'login.microsoftonline.com') return validade ? { access_token: 'AT' + (++emitidos), expires_in: validade, token_type: 'Bearer' } : { access_token: 'sem-validade' };
    throw new Error('transporte: destino inesperado ' + opts.hostname);
  };

  /* o servidor https local: o storage (lê ensaio.json, aceita PUT, 404 no resto) e as respostas do caso 8 */
  const recebidos = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(cert, 'chave.pem')), cert: fs.readFileSync(path.join(cert, 'cert.pem')) }, (req, res) => {
    const b = []; req.on('data', (x) => b.push(x));
    req.on('end', () => {
      const rota = req.url.split('?')[0];
      recebidos.push({ metodo: req.method, rota, auth: req.headers.authorization || '' });
      if (rota === '/mudo') return;   // nunca responde
      if (rota === '/entra-400') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_client","error_description":"AADSTS70021: No matching federated identity record found"}'); }
      if (rota === '/nao-json') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>portal cativo</html>'); }
      const h = { 'x-ms-request-id': 'ensaio', 'x-ms-version': '2025-01-05', etag: '"0x8ENSAIO"', 'last-modified': 'Sat, 25 Oct 2026 12:00:00 GMT' };
      if (req.method === 'PUT') { res.writeHead(201, h); return res.end(); }
      if (/\/dados\/ensaio\.json$/.test(rota)) {
        const corpo = Buffer.from('{"lido":"pelo oidc"}');
        res.writeHead(200, Object.assign(h, { 'content-type': 'application/json', 'content-length': corpo.length, 'x-ms-blob-type': 'BlockBlob' }));
        return res.end(req.method === 'HEAD' ? undefined : corpo);
      }
      res.writeHead(404, Object.assign(h, { 'x-ms-error-code': 'BlobNotFound' })); res.end();
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const LOCAL = 'https://127.0.0.1:' + srv.address().port;
  try {
    // 1. a chave
    limpa(); process.env.DADOS_STORAGE = CHAVE;
    let LC = novo();
    let c = LC.conteiner('dados');
    caso(LC.credencial() === 'chave' && c.url === 'https://contaensaio.blob.core.windows.net/dados', '1: a chave abre a conta da cadeia de conexão (' + c.url + ')');
    process.env.DADOS_STORAGE = 'DefaultEndpointsProtocol=https;AccountName=contaensaio;AccountKey=' + CHAVE_B64 + ';BlobEndpoint=' + LOCAL + '/contaensaio';
    LC = novo();
    await LC.conteiner('dados').getBlockBlobClient('pela-chave.json').upload(Buffer.from('{}'), 2);
    const pk = recebidos.find((x) => x.rota === '/contaensaio/dados/pela-chave.json');
    caso(pk && /^SharedKey contaensaio:/.test(pk.auth), '1: a gravação pela chave chega assinada com a chave compartilhada (' + (pk ? pk.auth.slice(0, 22) : 'nenhum pedido') + '…)');

    // 2. sem credencial, com o OIDC pela metade, com variável só de espaço
    limpa(); LC = novo();
    let erro = ''; try { LC.conteiner('dados'); } catch (e) { erro = e.message; }
    caso(LC.credencial() === null && /falta: AZURE_CLIENT_ID, AZURE_TENANT_ID, ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN\)$/.test(erro),
      '2: sem credencial estoura nomeando as quatro peças (' + erro + ')');
    Object.assign(process.env, OIDC); delete process.env.AZURE_TENANT_ID; LC = novo();
    erro = ''; try { LC.conteiner('dados'); } catch (e) { erro = e.message; }
    caso(LC.credencial() === null && /\(falta: AZURE_TENANT_ID\)$/.test(erro), '2: o OIDC pela metade estoura nomeando só o que falta (' + erro + ')');
    Object.assign(process.env, OIDC, { AZURE_CLIENT_ID: '   ' }); LC = novo();
    erro = ''; try { LC.conteiner('dados'); } catch (e) { erro = e.message; }
    caso(LC.credencial() === null && /\(falta: AZURE_CLIENT_ID\)$/.test(erro), '2: variável só de espaço conta como ausente (' + erro + ')');

    // 3. a chave e o OIDC juntos
    limpa(); Object.assign(process.env, OIDC, { DADOS_STORAGE: CHAVE }); LC = novo();
    caso(LC.credencial() === 'chave' && LC.conteiner('dados').url.indexOf('contaensaio.blob.core.windows.net') > 0,
      '3: a chave e o OIDC juntos: vence a chave (credencial ' + LC.credencial() + ')');

    // 4. a troca do OIDC
    limpa(); Object.assign(process.env, OIDC); LC = novo(); LC._usaTransporte(transporte);
    c = LC.conteiner('dados');
    caso(LC.credencial() === 'oidc' && c.url === 'https://rbenergydata.blob.core.windows.net/dados', '4: o OIDC abre a conta de produção (' + c.url + ')');
    let t = await c.credential.getToken(['https://storage.azure.com/.default']);
    const [g, a] = pedidos;
    const corpoA = new URLSearchParams(a ? a.corpo : '');
    caso(pedidos.length === 2 && g.opts.method === 'GET' && /[?&]audience=api%3A%2F%2FAzureADTokenExchange(&|$)/.test(g.opts.path) && /api-version=2\.0/.test(g.opts.path)
      && g.opts.headers.Authorization === 'Bearer pedido-do-job', '4: o pedido ao GitHub leva o audience do Entra e o token do job');
    caso(a.opts.method === 'POST' && a.opts.path === '/locatario-ensaio/oauth2/v2.0/token' && corpoA.get('client_id') === 'cliente-ensaio'
      && corpoA.get('scope') === 'https://storage.azure.com/.default' && corpoA.get('grant_type') === 'client_credentials'
      && corpoA.get('client_assertion') === 'assercao-1' && /jwt-bearer$/.test(corpoA.get('client_assertion_type') || ''),
      '4: o pedido ao Entra leva o cliente, o escopo do storage e a asserção do GitHub');
    caso(t.token === 'AT1', '4: o token de acesso é o que o Entra devolveu (' + t.token + ')');

    // 5. guardado, renovado a 5 min do fim (dos dois lados da borda), o mesmo entre contêineres
    const agora = Date.now; let mais = 0; Date.now = () => agora() + mais;
    try {
      mais = (54 * 60 + 59) * 1000; t = await c.credential.getToken();
      caso(t.token === 'AT1' && pedidos.length === 2, '5: o token fica guardado enquanto faltar mais de 5 min (54:59 depois: ' + t.token + ', ' + pedidos.length + ' pedidos)');
      caso(LC.conteiner('scada-raw').credential === c.credential, '5: dois contêineres usam a mesma credencial (o mesmo token)');
      mais = (55 * 60 + 1) * 1000; t = await c.credential.getToken();
      caso(t.token === 'AT2' && pedidos.length === 4, '5: a 5 min do fim o token é trocado de novo (55:01 depois: ' + t.token + ', ' + pedidos.length + ' pedidos)');
    } finally { Date.now = agora; }

    // 6. de ponta a ponta pelo SDK
    limpa(); Object.assign(process.env, OIDC, { DADOS_CONTA_URL: LOCAL + '/contaensaio' });
    LC = novo(); LC._usaTransporte(transporte); emitidos = 10;
    const LD6 = require(path.join(dir, 'lib-le-dados.js'));
    caso(LD6.modo() === 'sdk', '6: a lib-le-dados com o OIDC lê pelo SDK (modo ' + LD6.modo() + ')');
    let j = null; erro = '';
    try { j = await LD6.json(LD6.BASE + 'ensaio.json'); } catch (e) { erro = e.message; }
    const r1 = recebidos.find((x) => x.metodo === 'GET' && x.rota === '/contaensaio/dados/ensaio.json');
    caso(j && j.lido === 'pelo oidc' && r1 && r1.auth === 'Bearer AT11',
      '6: a leitura chega ao storage com o token de acesso (' + (r1 ? r1.rota + ' · ' + r1.auth : 'nenhum pedido') + (erro ? ' · ' + erro : '') + ')');
    let aus; erro = '';
    try { aus = await LD6.bytes(LD6.BASE + 'nao-existe.json'); } catch (e) { erro = e.message; }
    caso(aus === null, '6: o 404 do próprio blob continua sendo "não existe"' + (erro ? ' (' + erro + ')' : ''));
    erro = '';
    try { await LC.conteiner('dados').getBlockBlobClient('gravado.json').upload(Buffer.from('{}'), 2); } catch (e) { erro = e.message; }
    const p1 = recebidos.find((x) => x.metodo === 'PUT' && x.rota === '/contaensaio/dados/gravado.json');
    caso(p1 && p1.auth === 'Bearer AT11', '6: a gravação chega ao storage com o mesmo token (' + (p1 ? p1.auth : 'nenhum PUT') + (erro ? ' · ' + erro : '') + ')');

    // 7. as leituras de sempre, e a ordem declarada
    limpa(); process.env.DADOS_SAS = 'sv=ensaio&sig=ensaio'; novo();
    let LD = require(path.join(dir, 'lib-le-dados.js'));
    caso(LD.modo() === 'sas', '7: com a DADOS_SAS e sem o OIDC, segue no modo sas (' + LD.modo() + ')');
    limpa(); novo(); LD = require(path.join(dir, 'lib-le-dados.js'));
    caso(LD.modo() === 'publico', '7: sem nada, segue no modo publico (' + LD.modo() + ')');
    limpa(); Object.assign(process.env, OIDC, { DADOS_SAS: 'sv=ensaio&sig=ensaio' }); novo(); LD = require(path.join(dir, 'lib-le-dados.js'));
    caso(LD.modo() === 'sdk', '7: o OIDC com a DADOS_SAS lê pelo SDK, a ordem que a lib-le-dados declara (' + LD.modo() + ')');

    // 8. o transporte de verdade da troca, contra o servidor local
    limpa(); LC = novo();
    const P = LC._pedeJsonHttps;
    const via = (rota, ms) => P({ hostname: '127.0.0.1', port: srv.address().port, path: rota, method: 'GET', timeout: ms || 5000 });
    erro = ''; try { await via('/entra-400'); } catch (e) { erro = e.message; }
    caso(/^HTTP 400 · .*AADSTS70021/.test(erro), '8: o erro do Entra chega com o status e o corpo (' + erro.slice(0, 70) + ')');
    erro = ''; const t0 = Date.now();
    // o relógio do próprio ensaio: sem o `timeout` da lib a promessa nunca termina, e o caso tem de reprovar com o nome dele
    try { await Promise.race([via('/mudo', 700), new Promise((_, ko) => setTimeout(() => ko(new Error('sem resposta em 3 s')), 3000))]); } catch (e) { erro = e.message; }
    caso(/^tempo esgotado em 127\.0\.0\.1$/.test(erro) && Date.now() - t0 < 5000, '8: servidor mudo estoura por tempo (' + erro + ', ' + (Date.now() - t0) + ' ms)');
    erro = ''; try { await via('/nao-json'); } catch (e) { erro = e.message; }
    caso(/^resposta que não é JSON de 127\.0\.0\.1/.test(erro), '8: resposta 200 que não é JSON rejeita, sem derrubar o processo (' + erro + ')');
    limpa(); Object.assign(process.env, OIDC); LC = novo(); LC._usaTransporte(transporte); validade = 0;
    erro = ''; try { await LC.conteiner('dados').credential.getToken(); } catch (e) { erro = e.message; }
    caso(/o Entra não devolveu o token de acesso/.test(erro), '8: o Entra sem expires_in é recusado (' + erro + ')');

    // 8. nova tentativa: o erro que passa sozinho (429, 5xx, rede) é repetido com espera crescente; o de configuração (AADSTS, 400) não
    const tenta = async (falhasEntra, status) => {
      limpa(); Object.assign(process.env, OIDC); const L = novo(); const esperas = []; let chamadas = 0, token = null, err = '';
      L._usaEspera(async (ms) => { esperas.push(ms); });
      L._usaTransporte(async (o) => {
        if (o.hostname === 'gh.exemplo.invalid') return { value: 'assercao-r' };
        chamadas++;
        if (chamadas <= falhasEntra) throw new Error('HTTP ' + status + ' · {"error":"' + (status === 400 ? 'invalid_client","error_description":"AADSTS70021' : 'temporarily_unavailable') + '"}');
        return { access_token: 'AT-R', expires_in: 3600 };
      });
      try { token = (await L.conteiner('dados').credential.getToken()).token; } catch (e) { err = e.message; }
      return { token, err, chamadas, esperas: esperas.join(',') };
    };
    let x = await tenta(1, 503);
    caso(x.token === 'AT-R' && x.chamadas === 2 && x.esperas === '2000', '8: o 503 isolado do Entra passa na segunda tentativa ('
      + x.chamadas + ' pedidos, esperas ' + (x.esperas || '-') + (x.err ? ', ' + x.err : '') + ')');
    x = await tenta(1, 400);
    caso(!x.token && /^HTTP 400 · .*AADSTS70021/.test(x.err) && x.chamadas === 1 && x.esperas === '', '8: o AADSTS (400) estoura na primeira, sem esperar ('
      + x.chamadas + ' pedido(s), esperas ' + (x.esperas || '-') + ')');
    x = await tenta(9, 503);
    caso(!x.token && /^HTTP 503/.test(x.err) && x.chamadas === 4 && x.esperas === '2000,5000,10000', '8: o 503 que não passa estoura na quarta tentativa ('
      + x.chamadas + ' pedidos, esperas ' + (x.esperas || '-') + ')');

    // 9. os geradores migrados, de verdade, num processo à parte (o servidor tem de seguir respondendo: execFile, não spawnSync)
    const pre = path.join(dir, 'pre-oidc.js');
    fs.writeFileSync(pre, 'require(' + JSON.stringify(path.join(__dirname, 'lib-conteiner.js')) + ')._usaTransporte(async (o) => '
      + "o.hostname === 'login.microsoftonline.com' ? { access_token: 'AT-GERADOR', expires_in: 3600 } : { value: 'assercao-gerador' });\n");
    const { execFile } = require('child_process');
    for (const w of Object.keys(MIGRADOS)) for (const [g, envG] of Object.entries(MIGRADOS[w])) {
      if (!envG) continue;   // só a fiação (rede de fora)
      const env = Object.assign({}, process.env, OIDC, envG, { DADOS_CONTA_URL: LOCAL + '/contaensaio' });
      delete env.DADOS_STORAGE; delete env.DADOS_SAS; delete env.LOCAL_OUT;
      const saida = await new Promise((ok) => execFile(process.execPath, ['-r', pre, path.join(__dirname, g)], { env, timeout: 20000 },
        (e, so, se) => ok((so || '') + (se || '') + (e ? '\nERRO ' + e.message : ''))));
      const put = recebidos.find((x) => x.metodo === 'PUT' && x.rota === '/contaensaio/' + envG.OUT_CONTAINER + '/' + envG.OUT_BLOB);
      const falhou = /\nERRO /.test(saida);
      caso(put && put.auth === 'Bearer AT-GERADOR' && !falhou, '9: ' + g + ' (' + w + ') grava pelo OIDC ('
        + (put ? put.rota + ' · ' + put.auth : 'nenhum PUT') + (falhou ? ' · ' + saida.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200) : '') + ')');
    }
  } finally { srv.close(); srv.closeAllConnections && srv.closeAllConnections(); }

  console.log('suíte: ' + n + ' casos ok');
}
