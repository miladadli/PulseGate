import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  AppDataSource,
  LedgerSettleWorker,
  TypeOrmWalletRepository,
} from '@pulsegate/infrastructure';

async function main() {
  const ds: DataSource = await AppDataSource.initialize();
  const wallets = new TypeOrmWalletRepository(ds);

  const worker = new LedgerSettleWorker(wallets, {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim()),
    redisHost: process.env.REDIS_HOST ?? 'localhost',
    redisPort: Number(process.env.REDIS_PORT ?? 6379),
    batchSize: Number(process.env.LEDGER_BATCH_SIZE ?? 50),
    flushIntervalMs: Number(process.env.LEDGER_FLUSH_MS ?? 2000),
  });

  const shutdown = async () => {
    await worker.stop();
    await ds.destroy();
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
