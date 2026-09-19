import { isIP } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';

export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.NODE_ENV === 'production' ||
    Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID)
  );
}

/** Validate deployment settings before creating a database for the autonomous runtime. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = isProductionEnvironment(env);
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535.');
  const host = env.POG_LISTEN_HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
  if (!isIP(host) && host !== 'localhost')
    throw new Error('POG_LISTEN_HOST must be an IP address or localhost.');
  const workerIntervalMs = Number(env.POG_WORKER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(workerIntervalMs) || workerIntervalMs < 10_000)
    throw new Error('POG_WORKER_INTERVAL_MS must be at least 10000.');
  for (const name of ['POG_AUTOMATION_ENABLED', 'POG_TRANSACTIONS_ENABLED']) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name]!))
      throw new Error(`${name} must be true or false.`);
  }
  const dbPath = env.POG_DB_PATH ?? resolve('.data/pog.db');
  const allowedOrigins = env.POG_ALLOWED_ORIGINS?.split(',').map((value) => value.trim());
  const railway = Boolean(
    env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID,
  );
  const volumePath = railway ? env.RAILWAY_VOLUME_MOUNT_PATH : undefined;
  if (production) {
    if (!env.POG_DB_PATH || !isAbsolute(dbPath) || resolve(dbPath) === '/')
      throw new Error('Production requires an absolute POG_DB_PATH on persistent storage.');
    if (
      !allowedOrigins?.length ||
      allowedOrigins.some((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol !== 'https:' ||
            url.origin !== value ||
            url.hostname.includes('*') ||
            Boolean(url.username || url.password)
          );
        } catch {
          return true;
        }
      })
    )
      throw new Error(
        'Production requires explicit HTTPS POG_ALLOWED_ORIGINS without paths or wildcards.',
      );
    if (railway) {
      if (!volumePath || !isAbsolute(volumePath) || resolve(volumePath) === '/')
        throw new Error('Attach a persistent Railway volume before starting the ledger.');
      const location = relative(resolve(volumePath), resolve(dbPath));
      if (!location || location === '..' || location.startsWith('../') || isAbsolute(location))
        throw new Error('POG_DB_PATH must be a file inside the attached Railway volume.');
    }
  }
  return {
    production,
    host,
    port,
    dbPath,
    allowedOrigins,
    workerIntervalMs,
    automationEnabled: env.POG_AUTOMATION_ENABLED === 'true',
    transactionsEnabled: env.POG_TRANSACTIONS_ENABLED === 'true',
    volumePath,
  };
}
