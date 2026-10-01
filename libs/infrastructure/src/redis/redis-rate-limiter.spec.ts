import Redis from 'ioredis';
import { RedisRateLimiter } from './redis-rate-limiter';

describe('RedisRateLimiter', () => {
  let redis: Redis;
  const userId = `rl-test-${Date.now()}`;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: 1,
    });
  });

  afterAll(() => {
    redis.disconnect();
  });

  it('allows up to limit then denies', async () => {
    const limiter = new RedisRateLimiter(redis, {
      normalLimit: 3,
      expressLimit: 3,
      windowSec: 60,
    });
    const a = await limiter.tryAdmit({ userId, priority: 'normal' });
    const b = await limiter.tryAdmit({ userId, priority: 'normal' });
    const c = await limiter.tryAdmit({ userId, priority: 'normal' });
    const d = await limiter.tryAdmit({ userId, priority: 'normal' });
    expect(a.allowed && b.allowed && c.allowed).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});
