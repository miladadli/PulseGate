import {
  buildMessageId,
  buildPayloadHash,
  heavyBucketKey,
} from './sms.ids';

describe('sms.ids', () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  it('builds deterministic messageId from userId + idempotency key', () => {
    const a = buildMessageId(userId, 'key-1');
    const b = buildMessageId(userId, 'key-1');
    const c = buildMessageId(userId, 'key-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('hashes payload including priority', () => {
    const base = { to: '+98912', body: 'hi', priority: 'express' };
    expect(buildPayloadHash(base)).toBe(buildPayloadHash({ ...base }));
    expect(buildPayloadHash(base)).not.toBe(
      buildPayloadHash({ ...base, body: 'bye' }),
    );
    expect(buildPayloadHash(base)).not.toBe(
      buildPayloadHash({ ...base, priority: 'normal' }),
    );
  });

  it('builds heavy partition key with userId#bucket', () => {
    const mid = buildMessageId(userId, 'x');
    const key = heavyBucketKey(userId, mid);
    expect(key.startsWith(`${userId}#`)).toBe(true);
    const bucket = Number(key.split('#')[1]);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(16);
  });
});
