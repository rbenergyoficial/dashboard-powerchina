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
  'way2-mes.yml': { 'gen-way2-mes.js': null },                                                 // etapa 4, os de 10 e 15 min e de hora em hora
  'way2-agg.yml': { 'gen-way2-agg.js': null, 'gen-fontes-saude.js': null },
  'trafo-medidor.yml': { 'gen-trafo-way2.js': null },
  'vigia.yml': { 'gen-relogio-watchdog.js': null },
  'ons-consolidado.yml': { 'gen-ons-consolidado.js': null, 'gen-corte-gemeo.js': null, 'audita-ppc-ons.js': null },   // etapa 4, os diários com mais scripts
  'portal-dia.yml': { 'gen-portal-dia.js': null },
  'inversores.yml': { 'gen-inversores.js': null },
  'estacao-logger.yml': { 'gen-estacao-logger.js': null, 'gen-agente-dia.js': null },
  'trafo.yml': { 'gen-trafo.js': null },
  'render-paineis.yml': { 'gen-render-paineis.js': null },
  'ppc.yml': { 'gen-ppc.js': null },
  'comparativo.yml': { 'gen-comparativo.js': null },
  'must-intra.yml': { 'gen-must-intra.js': null, 'gen-must-watchdog.js': null },                   // etapa 4, os frequentes do supervisório e do MUST
  'eneat-intradia-way2.yml': { 'gen-eneat-intradia.js': null },
  'inv-scada.yml': { 'gen-inv-scada.js': null },
  'perdas.yml': { 'gen-perdas.js': null },
  'audita-scada-raw.yml': { 'audita-scada-raw.js': null },                                     // etapa 4, auditorias e ensaios avulsos
  'benchmark-2025.yml': { 'gen-benchmark-ons.js': null },
  'way2-hist.yml': { 'backup-blob.js': null, 'gen-way2-hist.js': null, 'gen-agente-dia.js': null },   // etapa 4, os grandes diários
  'scada.yml': { 'gen-scada.js': null, 'gen-scada-db-vigia.js': null, 'gen-scada-intake-watchdog.js': null },
  'executivo.yml': { 'gen-benchmark-ons.js': null, 'gen-executivo.js': null, 'gen-irradiancia.js': null, 'gen-pr.js': null,   // etapa 4
    'gen-registro-projecao.js': null },
};
/* os workflows que só LEEM o `dados` (nenhum script deles grava): a SAS de leitura no lugar da chave, e nenhum OIDC */
const SO_LEITURA = ['ensaio-comparativo.yml', 'ensaio-must.yml'];
/* os que nem leem o storage (só falam com a API de fora): nenhuma credencial do storage, nem a de leitura */
const SEM_STORAGE = ['audita-must.yml', 'audita-way2-grandezas.yml', 'ensaio-alerta.yml'];
/* os passos que só LEEM o storage de verdade (o publicado), de cada workflow migrado: pelo OIDC ou pela SAS só de leitura (DADOS_LEITURA).
   O ensaio sem rede não entra aqui: ele não pode ter credencial nenhuma. */
const LEITORES = {
  'trafo-medidor.yml': ['ensaio-trafo-way2.js --produto'],
  'vigia.yml': ['ensaio-selo-frescor.js'],
  'ons-consolidado.yml': ['ensaio-portao-gemeo.js --produto', 'ensaio-gemeo-mwh.js', 'ensaio-ppc.js'],
  'estacao-logger.yml': ['ensaio-agente-dia.js'],
  'ppc.yml': ['ensaio-ppc-duracao.js --produto'],
  'must-intra.yml': ['alerta-must.js'],
  'inv-scada.yml': ['ensaio-inv-scada-dia.js'],
  'executivo.yml': ['ensaio-aovivo.js', 'ensaio-atingido-mwh.js', 'ensaio-corte-ufv.js', 'ensaio-disp-declarada.js --produto',
    'ensaio-fechamento-dia.js', 'ensaio-fontes-exec.js --produto', 'ensaio-hierarquia.js', 'ensaio-historico-projecao.js --produto',
    'ensaio-historico-projecao.js --registro', 'ensaio-irr-datalogger.js --produto', 'ensaio-irr-ons-tag.js --produto',
    'ensaio-irr-rotulo.js --produto', 'ensaio-irr-travada.js --produto', 'ensaio-liquidada-produto.js', 'ensaio-manchete-mwh.js',
    'ensaio-manchete-noite.js --produto', 'ensaio-manchete-remendo.js', 'ensaio-mes-aberto.js', 'ensaio-motivo-ufv.js', 'ensaio-par-mwh.js',
    'ensaio-pr-ufv.js --produto', 'ensaio-pr.js', 'ensaio-ref-conjunto.js --produto', 'ensaio-ref-dia.js', 'ensaio-tol-rateio.js'],
  'way2-hist.yml': ['ensaio-med-ufv.js --produto', 'ensaio-w2-bruta-usina.js --produto', 'ensaio-fontes-exec.js --diario', 'ensaio-agente-dia.js'],
  'perdas.yml': ['ensaio-disponibilidade.js', 'ensaio-disp-retroativa.js', 'ensaio-setpoint-unidade.js', 'ensaio-pvstr-hora.js M3',
    'ensaio-isol-zero.js M3', 'ensaio-ef-imp.js M3', 'ensaio-disp-contrato.js', 'ensaio-energia-conjunto.js', 'ensaio-sem-registro.js',
    'ensaio-inversor-cru.js', 'ensaio-leitura-congelada.js', 'ensaio-rampa-amanhecer.js', 'ensaio-strings.js'],
};
/* a chave em qualquer das formas de lê-la: a CHAMADA da cadeia de conexão (o `fromConnectionString:` de um SDK simulado não conta), a
   chamada por colchete, a credencial de chave, a variável por ponto, por colchete ou desestruturada. Fica de fora, declarado: a variável lida
   por um apelido de process.env (`const E = process.env; E.DADOS_STORAGE`) */
const CHAVE_RE = /\.fromConnectionString\(|\[\s*['"]fromConnectionString['"]\s*\]\s*\(|StorageSharedKeyCredential|process\.env(?:\.|\[\s*['"])DADOS_STORAGE|\{[^}]*\bDADOS_STORAGE\b[^}]*\}\s*=\s*process\.env/;
/* `node scripts/x.js`, também com opções do node antes (`node --max-old-space-size=4096 scripts/x.js`) */
const NODE_RE = /node(?:\s+--[\w-]+(?:=\S+)?)*\s+scripts\/([\w.-]+\.js)/g;
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
    const prob = fiacao(WF(w), Object.keys(MIGRADOS[w]), GEN, LEITORES[w]);
    ok(prob.length === 0, w + ': sem a chave, com o OIDC, e os geradores pela lib-conteiner' + (prob.length ? ' (' + prob.join('; ') + ')' : ''));
  }
  for (const w of SO_LEITURA) {
    const prob = fiacaoLeitura(WF(w), GEN);
    ok(prob.length === 0, w + ': só leitura, pela SAS de leitura, sem a chave e sem OIDC' + (prob.length ? ' (' + prob.join('; ') + ')' : ''));
  }
  for (const w of SEM_STORAGE) {
    const prob = fiacaoSemStorage(WF(w), GEN);
    ok(prob.length === 0, w + ': não usa o storage e não tem credencial dele' + (prob.length ? ' (' + prob.join('; ') + ')' : ''));
  }
  {
    const wf = WF('audita-must.yml'), lendo = (g) => (g === 'audita-way2-grandezas.js' ? "const LD = require('./lib-le-dados');\n" + GEN(g) : GEN(g));
    let prob = fiacaoSemStorage(wf.replace('    timeout-minutes:', '    env:\n      DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n    timeout-minutes:'), GEN);
    ok(prob.some((x) => /credencial do storage num workflow/.test(x)), 'fiação plantada "a SAS num workflow que não usa o storage" reprova');
    prob = fiacaoSemStorage(WF('audita-way2-grandezas.yml'), lendo);
    ok(prob.some((x) => /carrega lib-le-dados\.js/.test(x)), 'fiação plantada "um script sem storage passando a ler o dados" reprova');
  }
  for (const [nome, de, para, esperado] of [
    ['a chave de volta num workflow só de leitura', '      DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n', '      DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n      DADOS_STORAGE: ${{ secrets.DADOS_STORAGE }}\n', 'ainda cita secrets.DADOS_STORAGE'],
    ['o OIDC num workflow só de leitura', '      DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n', '      DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n      AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}\n', 'OIDC num workflow só de leitura'],
    ['o workflow só de leitura sem a SAS', '      DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n', '', 'sem a SAS de leitura'],
    ['o gerador sem LOCAL_OUT num workflow de leitura', '          LOCAL_OUT: /tmp/ensaio/must_diario.json\n', '', 'carrega a lib-conteiner e roda sem LOCAL_OUT']]) {
    const wf = WF('ensaio-must.yml'), casou = wf.split(de).length === 2;
    const prob = fiacaoLeitura(wf.split(de).join(para), GEN);
    ok(casou && prob.some((x) => x.indexOf(esperado) >= 0), 'fiação plantada "' + nome + '" reprova em "' + esperado + '"' + (casou ? '' : ' (TRECHO NÃO CASOU)'));
  }
  /* fiação plantada: [nome, workflow, trocas no texto do workflow ([de, para], ou uma lista delas) ou null, arquivos trocados {arq: [de, para]},
     o que tem de acusar] */
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
    ['o gerador chamado com opções do node, pela cadeia de conexão', 'way2-agg.yml', null, { 'gen-way2-agg.js': ["require('./lib-conteiner').conteiner(CONTAINER)",
      "require('@azure/storage-blob').BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(CONTAINER)"] },
      'gen-way2-agg.js ainda depende da chave'],
    ['o passo de um gravador sem o OIDC', 'way2-agg.yml', ['        env:\n          AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}\n          AZURE_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}\n        run: node scripts/gen-fontes-saude.js',
      '        run: node scripts/gen-fontes-saude.js'], {}, 'gen-fontes-saude.js sem o OIDC'],
    ['o leitor sem credencial', 'vigia.yml', ['          DADOS_SAS: ${{ secrets.DADOS_LEITURA }}', '          OUTRA: x'], {}, 'ensaio-selo-frescor.js (leitor) sem credencial'],
    ['o id-token só no topo, com permissions no job', 'way2-mes.yml', [['permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n'],
      ['      id-token: write\n', '']], {}, 'sem id-token: write no permissions que vale'],
    ['o gravador num segundo passo sem o OIDC', 'vigia.yml', [['        run: node scripts/ensaio-selo-frescor.js\n',
      '        run: node scripts/ensaio-selo-frescor.js\n      - name: de novo\n        run: node scripts/gen-relogio-watchdog.js\n']], {}, 'gen-relogio-watchdog.js sem o OIDC'],
    ['uma linha de node que a fiação não lê', 'way2-mes.yml', ['run: node scripts/gen-way2-mes.js', 'run: node -r ./pre.js scripts/gen-way2-mes.js'], {},
      'linha de node que a fiação não reconhece'],
    ['o leitor sem credencial, com um passo vizinho do mesmo script sem rede', 'estacao-logger.yml', ['          DADOS_SAS: ${{ secrets.DADOS_LEITURA }}', '          OUTRA: x'], {},
      'ensaio-agente-dia.js (leitor) sem credencial'],
    ['o OIDC no env do job, com um ensaio sem rede no mesmo job', 'way2-mes.yml', ['      id-token: write\n',
      '      id-token: write\n    env:\n      AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}\n      AZURE_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}\n'], {},
      'o OIDC no env do job, com script que não grava (ensaio-way2-mes.js)'],
    ['um ensaio sem rede com credencial', 'estacao-logger.yml', ['        run: node scripts/ensaio-estacao-logger.js\n',
      '        env:\n          DADOS_SAS: ${{ secrets.DADOS_LEITURA }}\n        run: node scripts/ensaio-estacao-logger.js\n'], {},
      'ensaio-estacao-logger.js: passo sem rede com credencial'],
    ['a cadeia de conexão chamada por colchete', 'oleo.yml', null, { 'gen-oleo.js': ["require('./lib-conteiner').conteiner(OUT_CONTAINER)",
      "require('@azure/storage-blob').BlobServiceClient['fromConnectionString'](x).getContainerClient(OUT_CONTAINER)"] }, 'gen-oleo.js ainda depende da chave'],
  ];
  for (const [nome, w, trWf, trArq, esperado] of PLANTADAS) {
    let wf = WF(w), casou = true;
    for (const [de, para] of (!trWf ? [] : typeof trWf[0] === 'string' ? [trWf] : trWf)) { if (wf.split(de).length !== 2) casou = false; wf = wf.split(de).join(para); }
    const texto = (g) => { const s = GEN(g); if (!trArq[g]) return s; if (s.split(trArq[g][0]).length < 2) casou = false; return s.replace(trArq[g][0], trArq[g][1]); };
    const prob = fiacao(wf, Object.keys(MIGRADOS[w]), texto, LEITORES[w]);
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

/* o fecho dos require locais de um script (os nomes de arquivo de scripts/ que ele carrega, ele incluído) */
function fecho(m, texto) {
  const vistos = new Set(), fila = [m];
  while (fila.length) {
    const f = fila.shift();
    if (vistos.has(f)) continue;
    let t; try { t = texto(f); } catch (e) { continue; }   // módulo local que não é .js de scripts/ (um .json, por exemplo)
    vistos.add(f);
    for (const x of t.matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) fila.push(x[1] + '.js');
  }
  return vistos;
}
function semComentario(wf) { return wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') + '\n'; }

/* o que falta para um workflow que só LÊ o `dados` ficar sem a chave: a SAS de leitura, nenhum OIDC, nenhum script (nem o que ele
   carrega) dependendo da chave, e LOCAL_OUT no env de todo passo cujo script carrega a lib-conteiner (o gerador em modo local
   grava em disco; sem o LOCAL_OUT ele tentaria gravar no storage, sem credencial de gravação, e cairia só no disparo) */
function fiacaoLeitura(wf, texto) {
  const p = [];
  const w = semComentario(wf);
  if (/secrets\.DADOS_STORAGE/.test(w)) p.push('ainda cita secrets.DADOS_STORAGE');
  if (/AZURE_CLIENT_ID|AZURE_TENANT_ID/.test(w)) p.push('OIDC num workflow só de leitura: nada aqui grava');
  if (!/\n\s+DADOS_SAS: \$\{\{ secrets\.DADOS_LEITURA \}\}/.test(w)) p.push('sem a SAS de leitura (DADOS_LEITURA)');
  const UM = new RegExp(NODE_RE.source);
  for (const l of w.split('\n')) if (/\bnode\b.*scripts\//.test(l) && !UM.test(l)) p.push('linha de node que a fiação não reconhece: ' + l.trim().slice(0, 80));
  const iSteps = w.indexOf('\n    steps:');
  for (const s of (iSteps > 0 ? w.slice(iSteps) : '').split(/\n      - /).map((x) => x + '\n')) {
    for (const m of new Set([...s.matchAll(NODE_RE)].map((x) => x[1]))) {
      const F = fecho(m, texto);
      for (const f of F) if (f !== 'lib-conteiner.js' && CHAVE_RE.test(texto(f))) p.push(f + (f === m ? '' : ' (alcançado por ' + m + ')') + ' ainda depende da chave');
      // o gerador rodado como programa carrega a lib-conteiner direto; o ensaio que o carrega como módulo (para usar as peças) não grava
      if (/require\(\s*['"]\.\/lib-conteiner(?:\.js)?['"]\s*\)/.test(texto(m)) && !/\n\s+LOCAL_OUT: \S/.test(s)) p.push(m + ' carrega a lib-conteiner e roda sem LOCAL_OUT: gravaria no storage');
    }
  }
  return p;
}

/* o que falta para um workflow que nem lê o storage: nenhuma credencial do storage, e nenhum script carregando as libs do storage */
function fiacaoSemStorage(wf, texto) {
  const p = [];
  const w = semComentario(wf);
  if (/DADOS_STORAGE|DADOS_SAS|DADOS_LEITURA|AZURE_CLIENT_ID|AZURE_TENANT_ID/.test(w)) p.push('credencial do storage num workflow que não usa o storage');
  for (const m of new Set([...w.matchAll(NODE_RE)].map((x) => x[1]))) {
    for (const f of fecho(m, texto)) if (/^lib-(le-dados|conteiner|le-blob|cache-blob)\.js$/.test(f)) p.push(m + ' carrega ' + f + ': passou a usar o storage');
  }
  return p;
}

/* o que falta para um workflow gravar sem a chave; lista vazia = fiação certa. `leitores`: os passos que só LEEM o storage de verdade */
function fiacao(wf, gens, texto, leitores) {
  const p = [];
  const w = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') + '\n';   // comentário de YAML não conta
  if (/secrets\.DADOS_STORAGE/.test(w)) p.push('ainda cita secrets.DADOS_STORAGE');
  const iJobs = w.indexOf('\njobs:'), iSteps = w.indexOf('\n    steps:');
  const topo = iJobs > 0 ? w.slice(0, iJobs) + '\n' : '', cabJob = iSteps > 0 ? w.slice(Math.max(0, iJobs), iSteps) + '\n' : w;
  // o `permissions` do JOB sobrepõe o do topo inteiro: vale o do job, se houver; senão, o do topo
  const perm = /\n    permissions:\n/.test(cabJob) ? cabJob : topo;
  if (!/\n\s+id-token: write\n/.test(perm)) p.push('sem id-token: write no permissions que vale (o do job, se houver; senão o do topo)');
  if (!/\n\s+contents: read\n/.test(perm)) p.push('sem contents: read no permissions que vale (o permissions explícito zera o resto)');
  // o OIDC: as duas variáveis do repo no env do job (antes de `steps:`) ou no env de CADA passo que roda o gravador
  const AZ = (s) => /\n\s+AZURE_CLIENT_ID: \$\{\{ vars\.AZURE_CLIENT_ID \}\}\n/.test(s) && /\n\s+AZURE_TENANT_ID: \$\{\{ vars\.AZURE_TENANT_ID \}\}\n/.test(s);
  const SAS = (s) => /\n\s+DADOS_SAS: \$\{\{ secrets\.DADOS_LEITURA \}\}/.test(s);   // a SAS só de leitura
  const passos = (iSteps > 0 ? w.slice(iSteps) : '').split(/\n      - /).map((s) => s + '\n');
  for (const g of gens) {
    const ps = passos.filter((s) => s.indexOf('scripts/' + g) >= 0);
    if (!ps.length) p.push(g + ' não roda em nenhum passo do workflow');
    ps.forEach((s, i) => { if (!AZ(cabJob) && !AZ(s)) p.push(g + ' sem o OIDC (AZURE_CLIENT_ID e AZURE_TENANT_ID das variáveis do repo) no job nem no passo' + (ps.length > 1 ? ' (o ' + (i + 1) + 'º)' : '')); });
  }
  // os leitores: o storage de verdade, pelo OIDC ou pela SAS de leitura (sem nenhum, a lib-le-dados cai no público, e o `dados` é privado)
  for (const l of leitores || []) {
    // a linha inteira: `ensaio-agente-dia.js` (o produto, que lê) não é `ensaio-agente-dia.js --lib` (sem rede)
    const linha = new RegExp('scripts/' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*(\\n|#)');
    const ps = passos.filter((s) => linha.test(s));
    if (!ps.length) p.push(l + ' (leitor) não roda em nenhum passo do workflow');
    ps.forEach((s) => { if (!AZ(cabJob) && !AZ(s) && !SAS(s)) p.push(l + ' (leitor) sem credencial de leitura: nem o OIDC, nem a DADOS_SAS de leitura'); });
  }
  // a credencial fica só onde precisa: o OIDC no env do JOB só quando todo script do workflow é gravador (senão o ensaio sem rede herda
  // uma credencial real de gravação, e o que apaga a chave no filho para simular "sem credencial" troca um token de verdade); e passo que
  // não roda gravador nem leitor declarado não leva credencial nenhuma
  const ehLeitor = (s) => (leitores || []).some((l) => new RegExp('scripts/' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*(\\n|#)').test(s));
  const scriptsDe = (s) => [...s.matchAll(NODE_RE)].map((x) => x[1]);
  if (AZ(cabJob)) {
    const outros = [...new Set(scriptsDe(w))].filter((m) => gens.indexOf(m) < 0);
    if (outros.length) p.push('o OIDC no env do job, com script que não grava (' + outros.join(', ') + '): as variáveis vão no passo do gravador');
  }
  for (const s of passos) {
    const sc = scriptsDe(s);
    if (sc.length && !sc.some((m) => gens.indexOf(m) >= 0) && !ehLeitor(s) && (AZ(s) || SAS(s))) p.push(sc.join(', ') + ': passo sem rede com credencial');
  }
  // o primeiro passo falha fora do main (a credencial federada só vale para o main), pela variável de ambiente, nunca interpolada
  if (!/\n\s+if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then\n[^\n]*\n\s+exit 1\n/.test(w)) p.push('sem o passo que falha fora do main');
  // toda linha que chama `node ... scripts/` tem de ser reconhecida: o que a fiação não lê, ela não julga
  const UM = new RegExp(NODE_RE.source);
  for (const l of w.split('\n')) if (/\bnode\b.*scripts\//.test(l) && !UM.test(l)) p.push('linha de node que a fiação não reconhece: ' + l.trim().slice(0, 80));
  // todo script que o workflow roda, e tudo o que ele carrega de scripts/ (fechamento dos require locais, em qualquer profundidade),
  // sem a chave: sem ela no job, quem a exigir quebra. A lib-conteiner é a porta e fica de fora.
  for (const m of new Set([...w.matchAll(NODE_RE)].map((x) => x[1]))) {
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
  // gravador: carrega a lib-conteiner e abre por ela (direto, ou guardada numa variável: `const LC = require(...)`, `LC.conteiner(`)
  for (const g of gens) {
    const s = texto(g);
    if (!/require\(\s*['"]\.\/lib-conteiner(?:\.js)?['"]\s*\)/.test(s) || !/\.conteiner\(/.test(s)) p.push(g + ' não abre pela lib-conteiner');
  }
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
