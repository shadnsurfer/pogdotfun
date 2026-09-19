import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
export const sourceRoots = [
  'server',
  'src',
  'api',
  'tests',
  'docs',
  'public',
  'scripts',
  '.github',
];
export const sourceFiles = [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'vercel.json',
  'Dockerfile',
  '.dockerignore',
  '.gitignore',
  '.vercelignore',
  '.prettierrc.json',
  '.prettierignore',
  '.env.example',
];
export async function files(root = process.cwd()) {
  const result = [];
  async function walk(relative) {
    let stat;
    try {
      stat = await lstat(join(root, relative));
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not permitted: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of await readdir(join(root, relative))) await walk(join(relative, name));
    } else if (stat.isFile()) result.push(relative);
  }
  for (const path of [...sourceRoots, ...sourceFiles]) await walk(path);
  return result.sort();
}
