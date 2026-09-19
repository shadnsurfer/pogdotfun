import { mkdir, copyFile, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { files } from './source-files.mjs';
const check = spawnSync(process.execPath, ['scripts/check-source.mjs'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);
const destination = resolve('output/pog-source');
try {
  await lstat(destination);
  throw new Error('Source export already exists. Choose a fresh directory before exporting again.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const file of await files()) {
  const output = join(destination, file);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(file, output);
}
console.log(`Fresh source tree created: ${destination}`);
console.log('No repository history, private runtime state, deployment linkage, or remote changes.');
