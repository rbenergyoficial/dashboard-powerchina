// ensaio-canal-email.js — manda UM alerta de teste, de verdade, pelos canais configurados.
//
// 🔴 POR QUE ELE EXISTE
// Os outros ensaios do canal rodam contra um GitHub simulado, de proposito: um ensaio que abrisse
// issue de verdade a cada execucao encheria o repositorio do ruido que o dedup existe para evitar.
// Mas isso deixa um buraco — a LOGICA fica provada e o CAMINHO DE REDE nao. E canal de alerta que
// nunca foi exercitado nao esta testado: o dia em que ele falhar sera o dia em que ele precisava
// funcionar.
//
// Este ensaio fecha esse buraco, e por isso ele NAO roda sozinho: so por `workflow_dispatch`.
//
// ⚠️ O assunto e o corpo dizem, em letras grandes, que e teste. Um alerta de ensaio que se pareca
//    com um alerta de verdade custa uma ligacao de madrugada.
//
// ⚠️ E ele NAO usa `resolve`, nem `chave` de evento real: se usasse, fecharia um alarme legitimo
//    que estivesse aberto naquele instante.
'use strict';
const { alerta } = require('./lib-alerta');

(async () => {
  const quando = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const r = await alerta({
    tipo: 'ensaio-canal',
    chave: 'ensaio:canal',
    titulo: 'Ensaio do canal de alerta',
    assunto: '[ENSAIO — ignore] Canal de alerta do Mauriti · ' + quando + ' UTC',
    corpo: '<b>Isto e um ENSAIO do canal de alerta. Nenhuma falha aconteceu.</b><br><br>'
      + 'Ele existe para provar que o caminho de rede funciona ANTES de precisarmos dele — os '
      + 'outros ensaios provam a logica contra um GitHub simulado, e nao tocam a rede.<br><br>'
      + 'Disparado manualmente em ' + quando + ' UTC.<br><br>'
      + '<i>Se voce recebeu isto sem ter pedido, avise — significa que alguem disparou o ensaio '
      + 'por engano, ou que ele foi parar num agendamento.</i>',
  });

  console.log('\nresposta de cada canal:');
  for (const [k, v] of Object.entries(r)) console.log('  ' + k.padEnd(9) + v);

  // 🔴 O criterio e por CANAL, nao "algum funcionou". Um ensaio que passasse porque a issue subiu
  //    esconderia justamente o canal que se queria provar — e o e-mail e o unico que alcanca quem
  //    recebe os alertas hoje.
  const problemas = Object.entries(r)
    .filter(([, v]) => String(v).startsWith('FALHOU'))
    .map(([k, v]) => k + ': ' + v);
  const ativos = Object.entries(r).filter(([, v]) => String(v) !== '-').map(([k]) => k);

  if (problemas.length) {
    console.error('\nFALHOU em ' + problemas.length + ' canal(is):');
    problemas.forEach((p) => console.error('  ' + p));
    process.exit(1);
  }
  if (!ativos.length) {
    console.error('\nNENHUM canal configurado — o ensaio nao provou nada, e passar aqui seria pior '
      + 'que falhar');
    process.exit(1);
  }
  console.log('\ncanais exercitados de ponta a ponta: ' + ativos.join(', '));
  // ⚠️ Fecha a issue do ensaio: deixa-la aberta poria um alarme falso no radar de quem olha as
  //    issues para saber se ha algo errado.
  await alerta({ tipo: 'ensaio-canal', chave: 'ensaio:canal', resolve: true,
    titulo: 'Ensaio do canal de alerta',
    assunto: '[ENSAIO — ignore] canal conferido · ' + quando + ' UTC',
    corpo: 'O ensaio terminou. Nada a fazer.' });
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
