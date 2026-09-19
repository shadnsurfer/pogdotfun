import { readFile } from 'node:fs/promises';
import { files } from './source-files.mjs';
const retired = new RegExp(
  ['do' + 'no(?!r)', 'sol' + 'card', 'tik' + 'tok', 'four[ ._-]?' + 'meme'].join('|'),
  'i',
);
const secret = /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/;
const all = await files();
let failures = 0;
for (const file of all) {
  if (
    /(^|\/)(?:\.env(?!\.example$)|\.data|\.vercel|\.git|operator\.key)(\/|$)|\.(?:db|pem|key)$/.test(
      file,
    )
  ) {
    console.error('Private file in publication tree:', file);
    failures++;
    continue;
  }
  if (retired.test(file)) {
    console.error('Retired project/platform filename:', file);
    failures++;
  }
  if (/\.(?:png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i.test(file)) continue;
  const text = await readFile(file, 'utf8');
  if (retired.test(text)) {
    console.error('Retired project/platform reference:', file);
    failures++;
  }
  if (secret.test(text)) {
    console.error('Possible private credential:', file);
    failures++;
  }
}
if (failures) process.exitCode = 1;
else console.log(`Checked ${all.length} source files; publication scope is clean.`);
