#!/usr/bin/env node
/*
 * Gera o ADMIN_PASSWORD_HASH (scrypt) para a área administrativa.
 * A senha é digitada no terminal (sem aparecer na tela) e não é gravada em lugar nenhum.
 *
 *   node scripts/generate-admin-hash.js            # pede a senha duas vezes
 *   node scripts/generate-admin-hash.js --secret   # também gera um ADMIN_SESSION_SECRET
 *
 * Cole os valores em Netlify → Site configuration → Environment variables.
 */
const crypto = require('crypto');
const { hashPassword } = require('../functions/_lib/adminAuth');

const MIN_LENGTH = 12;

function ask(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('Rode este script num terminal interativo.'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const password = await ask('Nova senha do admin: ');
  if (password.length < MIN_LENGTH) {
    console.error(`A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`);
    process.exit(1);
  }
  if ((await ask('Repita a senha: ')) !== password) {
    console.error('As senhas não conferem.');
    process.exit(1);
  }
  console.log('\nADMIN_PASSWORD_HASH=' + (await hashPassword(password)));
  if (process.argv.includes('--secret')) {
    console.log('ADMIN_SESSION_SECRET=' + crypto.randomBytes(48).toString('base64url'));
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
