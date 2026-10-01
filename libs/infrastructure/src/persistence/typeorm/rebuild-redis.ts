import 'reflect-metadata';
import Redis from 'ioredis';
import { AppDataSource } from './data-source';
import { TypeOrmWalletRepository } from './typeorm-wallet.repository';
import { RedisCreditStore } from '../../redis/redis-credit.store';
import { RedisCreditRebuilder } from '../../redis/redis-credit-rebuilder';

async function main() {
  const ds = await AppDataSource.initialize();
  const wallets = new TypeOrmWalletRepository(ds);
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: 3,
  });
  const credits = new RedisCreditStore(redis);
  const rebuilder = new RedisCreditRebuilder(wallets, credits);

  try {
    const report = await rebuilder.rebuildConservative();
    // eslint-disable-next-line no-console
    console.log('Redis rebuild (conservative):', report);
  } finally {
    redis.disconnect();
    await ds.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
