import Redis from 'ioredis';
import { RedisCreditStore } from './redis-credit.store';

describe('RedisCreditStore admit/commit/refund', () => {
  let redis: Redis;
  let store: RedisCreditStore;
  const userId = `test-credit-${Date.now()}`;
  const walletKey = `wallet:${userId}:balance`;

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: 1,
    });
    store = new RedisCreditStore(redis);
  });

  beforeEach(async () => {
    await redis.set(walletKey, '10');
    // Exact keys only — KEYS scans the whole DB and times out after load tests.
    await redis.del(
      `idem:${userId}:k1`,
      `idem:${userId}:k2`,
      `idem:${userId}:k3`,
      `idem:${userId}:k4`,
    );
  });

  afterAll(async () => {
    await redis.del(walletKey);
    redis.disconnect();
  });

  it('admits, commits, and skips second produce path via DONE replay', async () => {
    const admit = await store.admitSms({
      userId,
      idempotencyKey: 'k1',
      messageId: '00000000-0000-4000-8000-000000000001',
      payloadHash: 'hash-a',
      cost: 1n,
      reservationTtlSec: 60,
    });
    expect(admit.status).toBe('ok');
    if (admit.status !== 'ok') return;

    expect(await redis.get(walletKey)).toBe('9');

    await store.commit({
      userId,
      idempotencyKey: 'k1',
      reservationId: admit.reservationId,
      messageId: admit.messageId,
    });

    const replay = await store.admitSms({
      userId,
      idempotencyKey: 'k1',
      messageId: '00000000-0000-4000-8000-000000000001',
      payloadHash: 'hash-a',
      cost: 1n,
      reservationTtlSec: 60,
    });
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.alreadyCommitted).toBe(true);
      expect(replay.replay).toBe(true);
    }
    expect(await redis.get(walletKey)).toBe('9');
  });

  it('detects payload mismatch on same idem key', async () => {
    await store.admitSms({
      userId,
      idempotencyKey: 'k2',
      messageId: '00000000-0000-4000-8000-000000000002',
      payloadHash: 'hash-a',
      cost: 1n,
      reservationTtlSec: 60,
    });
    const mismatch = await store.admitSms({
      userId,
      idempotencyKey: 'k2',
      messageId: '00000000-0000-4000-8000-000000000002',
      payloadHash: 'hash-b',
      cost: 1n,
      reservationTtlSec: 60,
    });
    expect(mismatch.status).toBe('payload_mismatch');
  });

  it('refunds PENDING reservation (grant-gap / failed produce path)', async () => {
    const admit = await store.admitSms({
      userId,
      idempotencyKey: 'k3',
      messageId: '00000000-0000-4000-8000-000000000003',
      payloadHash: 'hash-a',
      cost: 1n,
      reservationTtlSec: 60,
    });
    expect(admit.status).toBe('ok');
    if (admit.status !== 'ok') return;

    const outcome = await store.refund({
      userId,
      idempotencyKey: 'k3',
      reservationId: admit.reservationId,
      cost: 1n,
    });
    expect(outcome).toBe('refunded');
    expect(await redis.get(walletKey)).toBe('10');

    const noop = await store.refund({
      userId,
      idempotencyKey: 'k3',
      reservationId: admit.reservationId,
      cost: 1n,
    });
    expect(noop).toBe('noop');
  });

  it('returns insufficient when residual is empty', async () => {
    await redis.set(walletKey, '0');
    const admit = await store.admitSms({
      userId,
      idempotencyKey: 'k4',
      messageId: '00000000-0000-4000-8000-000000000004',
      payloadHash: 'hash-a',
      cost: 1n,
      reservationTtlSec: 60,
    });
    expect(admit.status).toBe('insufficient');
  });
});
