import { SmsDispatchWorker, WorkerMode } from '@pulsegate/infrastructure';

async function main() {
  const mode = (process.env.WORKER_MODE ?? 'express') as WorkerMode;
  if (!['express', 'normal', 'heavy'].includes(mode)) {
    throw new Error(`Invalid WORKER_MODE=${mode}`);
  }

  const worker = new SmsDispatchWorker({
    mode,
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim()),
    operatorUrl: process.env.OPERATOR_SIM_URL ?? 'http://localhost:3010',
    redisHost: process.env.REDIS_HOST ?? 'localhost',
    redisPort: Number(process.env.REDIS_PORT ?? 6379),
    maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS ?? 3),
    perTenantGapMs: Number(process.env.WORKER_TENANT_GAP_MS ?? 20),
    cbFailureThreshold: Number(process.env.CB_FAILURE_THRESHOLD ?? 5),
    cbOpenMs: Number(process.env.CB_OPEN_MS ?? 10000),
  });

  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await worker.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
