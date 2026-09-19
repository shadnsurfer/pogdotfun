import { loadWorkerBindings } from './worker-bindings.ts';
import { createApp } from './app.ts';
import { existsSync, statSync } from 'node:fs';
import { isProductionEnvironment, readRuntimeConfig } from './runtime-config.ts';

// Production uses injected service variables. Never pick up a developer's .env.
if (!isProductionEnvironment() && existsSync('.env.pog')) process.loadEnvFile('.env.pog');
const config = readRuntimeConfig();
process.umask(0o077);
if (
  config.volumePath &&
  (!existsSync(config.volumePath) || !statSync(config.volumePath).isDirectory())
)
  throw new Error(
    'The configured Railway volume is not mounted. Refusing to create an ephemeral ledger.',
  );
const workerBindings = await loadWorkerBindings(process.env.POG_WORKER_BINDINGS_MODULE);
const app = createApp({
  workerBindings,
  dbPath: config.dbPath,
  allowedOrigins: config.allowedOrigins,
  production: config.production,
});
let workerTimer: ReturnType<typeof setInterval> | undefined;
let launchTimer: ReturnType<typeof setInterval> | undefined;
let streamTimer: ReturnType<typeof setInterval> | undefined;

app.server.on('error', async (error) => {
  console.error('Pog API failed to start:', error.message);
  await app.close();
  process.exitCode = 1;
});
app.server.listen(config.port, config.host, () => {
  console.log(
    `Pog API listening on ${config.host}:${config.port} (${config.production ? 'production' : 'local'}; live workers require configuration)`,
  );
  // Finality reads only: no signing, preparation or transaction broadcast, including with spend flags off.
  const checkLaunches = () =>
    void app
      .runLaunchReconciliation()
      .catch(() =>
        console.error(
          'Launch transaction verification is pending. Existing signatures remain retained.',
        ),
      );
  launchTimer = setInterval(checkLaunches, 10_000);
  launchTimer.unref();
  checkLaunches();
  // Cheap heartbeat; each streamer's persisted deadline limits API polling to 30 minutes.
  const checkStreams = () =>
    void app
      .runStreamerChecks()
      .catch(() => console.error('Live status unavailable. Streamer funds remain held.'));
  streamTimer = setInterval(checkStreams, 30_000);
  streamTimer.unref();
  checkStreams();
  if (config.automationEnabled) {
    const check = () =>
      void app
        .runLedger()
        .catch(() => console.error('Ledger worker paused. Provider evidence is pending.'));
    workerTimer = setInterval(check, config.workerIntervalMs);
    workerTimer.unref();
    check();
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    if (workerTimer) clearInterval(workerTimer);
    if (streamTimer) clearInterval(streamTimer);
    if (launchTimer) clearInterval(launchTimer);
    await app.close();
    process.exitCode = 0;
  });
}
