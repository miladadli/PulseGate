import 'reflect-metadata';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import {
  AppDataSource,
  RedisCreditStore,
  ReservationReconciler,
  TypeOrmWalletRepository,
} from '@pulsegate/infrastructure';

async function main() {
  const ds: DataSource = await AppDataSource.initialize();
  const wallets = new TypeOrmWalletRepository(ds);
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: 3,
  });
  const credits = new RedisCreditStore(redis);

  const reconciler = new ReservationReconciler(wallets, credits, {
    redisHost: process.env.REDIS_HOST ?? 'localhost',
    redisPort: Number(process.env.REDIS_PORT ?? 6379),
    intervalMs: Number(process.env.RECONCILER_INTERVAL_MS ?? 3000),
    pendingGrantAgeMs: Number(process.env.RECONCILER_GRANT_AGE_MS ?? 5000),
  });

  const shutdown = async () => {
    await reconciler.stop();
    redis.disconnect();
    await ds.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await reconciler.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
