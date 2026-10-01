import { createHash, createHmac } from 'crypto';
import { v5 as uuidv5 } from 'uuid';

/** Fixed namespace UUID for deterministic message ids. */
export const PULSEGATE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function buildMessageId(userId: string, idempotencyKey: string): string {
  return uuidv5(`${userId}:${idempotencyKey}`, PULSEGATE_NAMESPACE);
}

export function buildPayloadHash(input: {
  to: string;
  body: string;
  priority: string;
}): string {
  return createHash('sha256')
    .update(`${input.to}\0${input.body}\0${input.priority}`)
    .digest('hex');
}

export function heavyBucketKey(userId: string, messageId: string): string {
  const h = createHmac('sha256', userId).update(messageId).digest();
  const bucket = h.readUInt16BE(0) % 16;
  return `${userId}#${bucket}`;
}
