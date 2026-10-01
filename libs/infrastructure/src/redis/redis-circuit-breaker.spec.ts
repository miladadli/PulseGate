import Redis from 'ioredis';
import { RedisCircuitBreaker } from './redis-circuit-breaker';

describe('RedisCircuitBreaker', () => {
  let redis: Redis;
  const name = `cb-test-${Date.now()}`;

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

  it('opens after failure threshold and blocks until success probe', async () => {
    const cb = new RedisCircuitBreaker(redis, {
      name,
      failureThreshold: 3,
      openMs: 2000,
    });

    expect(await cb.allow()).toBe(true);
    await cb.recordFailure();
    await cb.recordFailure();
    expect(await cb.recordFailure()).toBe('open');
    expect(await cb.allow()).toBe(false);

    // wait for open window
    await new Promise((r) => setTimeout(r, 2100));
    expect(await cb.allow()).toBe(true); // half-open probe
    await cb.recordSuccess();
    expect(await cb.allow()).toBe(true);
  }, 10000);
});
