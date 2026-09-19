import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { ServiceOptions } from './services.ts';
import type { AgentRole, SecretReader } from './security/secret-vault.ts';
export type WorkerBindings = (context: {
  db: DatabaseSync;
  env: NodeJS.ProcessEnv;
  secrets: { forRole(role: AgentRole): SecretReader };
}) => Pick<ServiceOptions, 'integrations' | 'feeSources' | 'buyback'>;
/** Trusted deployment code only. No network import, request parameter or browser-controlled module path. */
export async function loadWorkerBindings(
  path: string | undefined,
): Promise<WorkerBindings | undefined> {
  if (!path) return undefined;
  if (!isAbsolute(path) || !/\.(?:mjs|js|ts)$/.test(path))
    throw new Error('Worker bindings must be an absolute local module path.');
  try {
    const module = await import(pathToFileURL(path).href);
    if (typeof module.createWorkerBindings !== 'function') throw new Error();
    return module.createWorkerBindings as WorkerBindings;
  } catch {
    throw new Error('Trusted worker bindings could not be loaded.');
  }
}
