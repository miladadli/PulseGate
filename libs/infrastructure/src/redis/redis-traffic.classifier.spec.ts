import Redis from 'ioredis';
import { RedisTrafficClassifier } from './redis-traffic.classifier';

describe('RedisTrafficClassifier', () => {
  let redis: Redis;
  let classifier: RedisTrafficClassifier;
  const userId = `test-classifier-${Date.now()}`;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
  });

  beforeEach(async () => {
    await redis.connect().catch(() => undefined);
    classifier = new RedisTrafficClassifier(redis, 5, 2);
    const keys = await redis.keys(`ratewin:${userId}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.del(`heavy:${userId}`);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  it('keeps express on sms.express', async () => {
    await expect(
      classifier.classify({ userId, priority: 'express' }),
    ).resolves.toBe('sms.express');
  });

  it('routes normal to heavy after threshold', async () => {
    let last = 'sms.normal';
    for (let i = 0; i < 5; i++) {
      last = await classifier.classify({ userId, priority: 'normal' });
    }
    expect(last).toBe('sms.heavy');
    expect(await redis.get(`heavy:${userId}`)).toBe('1');
  });
});
