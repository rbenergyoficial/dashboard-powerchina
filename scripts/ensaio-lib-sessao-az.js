'use strict';
/*
 * ensaio-lib-sessao-az.js — prova o acesso das pontes da máquina sem a chave da conta (lib-sessao-az.js, lote coleta-sem-chave,
 * 28/10/2026). Sem rede e sem segredo: o az é simulado (a lib aceita o executor pelo _usaAz) e o token é um texto plantado.
 *   1. a chave (DADOS_STORAGE) continua vencendo: é por ela que os ensaios das pontes forjam o contêiner;
 *   2. sem DADOS_STORAGE: o az é chamado com exatamente os argumentos do token do storage, e o contêiner aponta para a conta pedida
 *      com o token no lugar da chave;
 *   3. o token fica guardado enquanto faltar mais de 5 min para vencer e é pedido de novo a 5 min do fim (dos dois lados da borda);
 *      dois contêineres do mesmo processo usam o mesmo token;
 *   4. o que o az devolve nunca aparece numa mensagem de erro: saída que não é JSON, resposta sem `expires_on` (só o `expiresOn`
 *      local), token vencido, comando que falha. Todos ESTOURAM, e nenhum volta para a chave;
 *   5. as duas pontes (sobre o texto): nenhuma pede a cadeia de conexão ao az, nenhuma monta o cliente pela cadeia de conexão por
 *      conta própria, as duas abrem o contêiner pela lib.
 * PLANTIOS (cada um TEM de reprovar algum caso e compilar): o token que nunca se renova; o token pedido a cada chamada; o
 * `expiresOn` local no lugar do `expires_on`; a mensagem do JSON.parse (que cita a saída) repassada; a sessão que vence a chave;
 * a falha do az que volta para a cadeia de conexão; a ponte que volta a pedir a chave.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ARQ = path.join(__dirname, 'lib-sessao-az.js');
const FONTE = fs.readFileSync(ARQ, 'utf8').replace(/\r\n/g, '\n');
const PONTES = ['coleta-inversores.js', 'coleta-ppc.js'];
const SEGREDO = 'Zq9XvW7plantadoNaoPodeVazar';   // o começo (Zq9Xv) nao ocorre em mensagem nenhuma da lib
const CASOS = 17;   // a suíte inteira; menos que isto é suíte que parou no meio

function compila(src) { const m = new Module(ARQ, module); m.filename = ARQ; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, ARQ); return m.exports; }

async function suite(M, pontes, fala) {
  let falhas = 0, n = 0;
  const diz = (nome, obtido, esperado) => { n += 1; const bom = JSON.stringify(obtido) === JSON.stringify(esperado);
    if (!bom) falhas += 1;
    if (fala || !bom) console.log('  ' + (bom ? '✅' : '🔴') + ' ' + nome + ' · ' + JSON.stringify(obtido) + (bom ? '' : ' (esperado ' + JSON.stringify(esperado) + ')')); };
  const tenta = async (f) => { try { return { ok: await f() }; } catch (e) { return { erro: String(e.message || e) }; } };
  const agora = Date.now;
  let relogio = agora();
  Date.now = () => relogio;
  const guardada = process.env.DADOS_STORAGE;
  try {
    /* o az simulado: devolve o que `resposta()` disser e conta as chamadas */
    let chamadas = [], resposta = null;
    const usa = () => M._usaAz((args) => { chamadas.push(args.join(' ')); const r = resposta(args); if (r instanceof Error) throw r; return r; });
    /* o expiresOn como o az o escreve (hora LOCAL, sem fuso), sempre no futuro do relógio do ensaio: data fixa vira bomba-relógio
       (às 14:29 de 28/10 o defeito "expiresOn no lugar do expires_on" passou a ser recusado por vencido e saiu sem ser pego) */
    const local = (ms) => { const d = new Date(ms), p = (x) => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.000000'; };
    const json = (vence) => JSON.stringify({ accessToken: SEGREDO, expiresOn: local(vence), expires_on: Math.floor(vence / 1000),
      tokenType: 'Bearer' });

    // 1 · a chave vence
    process.env.DADOS_STORAGE = 'DefaultEndpointsProtocol=https;AccountName=forjada;AccountKey=Zm9yamFkYQ==;EndpointSuffix=core.windows.net';
    usa(); resposta = () => json(relogio + 3600e3);
    const ck = await tenta(() => M.conteinerLocal('ppc-raw', 'rbenergydata'));
    diz('1 · com DADOS_STORAGE: a cadeia de conexão, sem chamar o az', [M.credencial(), ck.ok && ck.ok.url, chamadas.length],
      ['chave', 'https://forjada.blob.core.windows.net/ppc-raw', 0]);
    delete process.env.DADOS_STORAGE;

    // 2 · a sessão do az
    usa(); chamadas = []; resposta = () => json(relogio + 3600e3);
    const c = M.conteinerLocal('inversores-raw', 'rbenergydata');
    diz('2 · sem DADOS_STORAGE: sessao-az, na conta pedida', [M.credencial(), c.url], ['sessao-az', 'https://rbenergydata.blob.core.windows.net/inversores-raw']);
    diz('2 · o contêiner leva uma credencial de token, não a chave', [typeof (c.credential && c.credential.getToken), !!(c.credential && c.credential.accountKey)], ['function', false]);
    const t1 = await tenta(() => c.credential.getToken('https://storage.azure.com/.default'));
    diz('2 · o token é o que o az devolveu, com o vencimento do expires_on', [t1.ok && t1.ok.token === SEGREDO, t1.ok && t1.ok.expiresOnTimestamp,
      chamadas], [true, Math.floor((relogio + 3600e3) / 1000) * 1000, ['account get-access-token --resource https://storage.azure.com/ -o json']]);
    const c2 = M.conteinerLocal('ppc-raw', 'outraconta');
    diz('2 · a conta vem de quem chama', c2.url, 'https://outraconta.blob.core.windows.net/ppc-raw');

    // 3 · o token guardado e a borda dos 5 min (token de 60 min pedido no instante t0)
    const t0 = relogio; usa(); chamadas = []; resposta = () => json(t0 + 3600e3);
    const cA = M.conteinerLocal('inversores-raw', 'rbenergydata'), cB = M.conteinerLocal('ppc-raw', 'rbenergydata');
    await tenta(() => cA.credential.getToken()); await tenta(() => cB.credential.getToken());
    diz('3 · dois contêineres, um token só', [chamadas.length, cA.credential === cB.credential], [1, true]);
    relogio = t0 + (54 * 60 + 59) * 1000; await tenta(() => cA.credential.getToken());
    diz('3 · a 5:01 do fim: o mesmo token', chamadas.length, 1);
    relogio = t0 + (55 * 60 + 1) * 1000; await tenta(() => cA.credential.getToken());
    diz('3 · a 4:59 do fim: pede de novo', chamadas.length, 2);
    relogio = t0;

    // 4 · o que o az devolve nunca aparece no erro, e nada volta para a chave
    const falha = async (r) => { usa(); chamadas = []; resposta = r; const x = M.conteinerLocal('ppc-raw', 'rbenergydata');
      const e = await tenta(() => x.credential.getToken()); return [!!e.erro, String(e.erro || '').includes(SEGREDO.slice(0, 5)), M.credencial()]; };
    diz('4 · saída que não é JSON: estoura sem citar a saída', await falha(() => SEGREDO + ' }'), [true, false, 'sessao-az']);
    diz('4 · resposta sem expires_on (só o expiresOn local): recusa', await falha(() => JSON.stringify({ accessToken: SEGREDO, expiresOn: local(relogio + 3600e3) })),
      [true, false, 'sessao-az']);
    diz('4 · token vencido: recusa', await falha(() => json(relogio - 1000)), [true, false, 'sessao-az']);
    diz('4 · resposta sem token: recusa', await falha(() => JSON.stringify({ expires_on: Math.floor((relogio + 3600e3) / 1000) })), [true, false, 'sessao-az']);
    /* o az simulado SABERIA emitir a cadeia de conexão: a lib não pode pedi-la */
    const e5 = await (async () => { usa(); chamadas = []; resposta = (args) => (args[0] === 'storage'
      ? 'DefaultEndpointsProtocol=https;AccountName=rbenergydata;AccountKey=Zm9yamFkYQ==;EndpointSuffix=core.windows.net'
      : new Error('Command failed: az account get-access-token\nPlease run az login'));
      const x = M.conteinerLocal('ppc-raw', 'rbenergydata'); return tenta(() => x.credential.getToken()); })();
    diz('4 · comando que falha: estoura com o motivo e o caminho de volta (az login), sem pedir a chave',
      [/az login/.test(e5.erro || ''), /Command failed/.test(e5.erro || ''), chamadas], [true, true, ['account get-access-token --resource https://storage.azure.com/ -o json']]);

    // 5 · as pontes, sobre o texto
    for (const [nome, src] of pontes) {
      diz('5 · ' + nome + ': não pede a cadeia de conexão ao az nem a monta sozinha',
        [/show-connection-string/.test(src), /fromConnectionString/.test(src), /AccountKey/.test(src)], [false, false, false]);
      diz('5 · ' + nome + ': abre o contêiner pela lib', /require\('\.\/lib-sessao-az'\)\.conteinerLocal\(CONTAINER, CONTA\)/.test(src), true);
    }
  } finally {
    Date.now = agora;
    if (guardada === undefined) delete process.env.DADOS_STORAGE; else process.env.DADOS_STORAGE = guardada;
  }
  if (n !== CASOS) { falhas += 1; console.log('  🔴 a suíte rodou ' + n + ' caso(s), esperado ' + CASOS); }
  return falhas;
}

const PLANTIOS_LIB = [
  ['o token nunca se renova', 'if (atual && atual.expiresOnTimestamp - Date.now() > FOLGA_MS) return atual;', 'if (atual) return atual;'],
  ['o token é pedido a cada chamada', 'if (atual && atual.expiresOnTimestamp - Date.now() > FOLGA_MS) return atual;', ''],
  ['o expiresOn local no lugar do expires_on', 'const vence = Number(r && r.expires_on) * 1000;', 'const vence = r && (Number(r.expires_on) * 1000 || Date.parse(r.expiresOn));'],
  ['a mensagem do JSON.parse repassada', 'try { r = JSON.parse(txt); } catch (e) { r = null; }', "try { r = JSON.parse(txt); } catch (e) { throw new Error('lib-sessao-az: ' + e.message); }"],
  ['a sessão vence a chave', "return process.env.DADOS_STORAGE ? 'chave' : 'sessao-az';", "return 'sessao-az';"],
  ['a falha do az volta para a chave',
    "        throw new Error('lib-sessao-az: a sessão local do az não emitiu o token do storage ('",
    "        txt = az(['storage', 'account', 'show-connection-string', '-n', 'rbenergydata', '-o', 'json']);\n        if (txt) return { token: '', expiresOnTimestamp: 0 };\n        throw new Error('lib-sessao-az: a sessão local do az não emitiu o token do storage ('"],
];

(async () => {
  let falhas = 0;
  const pontes = PONTES.map((p) => [p, fs.readFileSync(path.join(__dirname, p), 'utf8')]);
  console.log('O FONTE DE VERDADE');
  falhas += await suite(compila(FONTE), pontes, true);

  console.log('\nDEFEITOS PLANTADOS (cada um tem de derrubar algum caso)');
  const julga = async (nome, M, ps) => { const k = await suite(M, ps, false);
    if (k > 0) console.log('  ✅ reprovado: ' + nome + ' (' + k + ' caso(s))'); else { falhas += 1; console.log('  🔴 PASSOU sem ser pego: ' + nome); } };
  for (const [nome, de, para] of PLANTIOS_LIB) {
    const n = FONTE.split(de).length - 1;
    if (n !== 1) { falhas += 1; console.log('  🔴 plantio "' + nome + '": o trecho ocorre ' + n + ' vez(es) no fonte (esperado 1)'); continue; }
    let M;
    try { M = compila(FONTE.replace(de, para)); } catch (e) { falhas += 1; console.log('  🔴 plantio "' + nome + '" NAO COMPILA (defeito do ensaio): ' + e.message.slice(0, 80)); continue; }
    await julga(nome, M, pontes);
  }
  /* a ponte que volta a pedir a chave: o trecho antigo, de volta numa das duas */
  const volta = pontes.map(([p, s], i) => [p, i ? s : s.replace("require('./lib-sessao-az').conteinerLocal(CONTAINER, CONTA)",
    "require('@azure/storage-blob').BlobServiceClient.fromConnectionString(require('child_process').execFileSync('az', ['storage', 'account', 'show-connection-string', '-n', CONTA], { encoding: 'utf8' })).getContainerClient(CONTAINER)")]);
  if (volta[0][1] === pontes[0][1]) { falhas += 1; console.log('  🔴 plantio "a ponte volta a pedir a chave": a troca nao mudou o fonte'); }
  else await julga('a ponte volta a pedir a chave', compila(FONTE), volta);

  console.log('\n' + (falhas ? '🔴 ' + falhas + ' falha(s)' : '✅ ensaio limpo'));
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
