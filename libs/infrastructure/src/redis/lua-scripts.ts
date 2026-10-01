/** KEYS[1]=wallet:{userId}:balance  KEYS[2]=lease:applied:{grantId}
 *  ARGV[1]=amount
 *  returns 1 if applied, 0 if already applied
 */
export const GRANT_LEASE_CREDIT_LUA = `
if redis.call('SETNX', KEYS[2], '1') == 0 then
  return 0
end
redis.call('INCRBY', KEYS[1], ARGV[1])
return 1
`;

/**
 * Atomic admit: idempotency + reserve + ZSET deadline.
 * KEYS[1]=idem:{userId}:{key}
 * KEYS[2]=wallet:{userId}:balance
 * KEYS[3]=reservations:deadlines
 * KEYS[4]=reservation:{reservationId}  (only used on new admit; reservationId in ARGV)
 * ARGV[1]=messageId ARGV[2]=payloadHash ARGV[3]=cost
 * ARGV[4]=reservationId ARGV[5]=deadlineScore (ms) ARGV[6]=idemTtlSec
 * ARGV[7]=userId ARGV[8]=idempotencyKey
 *
 * returns:
 *  {ok, messageId, reservationId, replay=0|1}
 *  {err='insufficient'}
 *  {err='payload_mismatch'}
 */
export const ADMIT_SMS_LUA = `
local idem = redis.call('HMGET', KEYS[1], 'state', 'messageId', 'payloadHash', 'reservationId')
local state = idem[1]
local existingMessageId = idem[2]
local existingHash = idem[3]
local existingReservationId = idem[4]

if state == 'DONE' then
  if existingHash ~= ARGV[2] then
    return { 'err', 'payload_mismatch' }
  end
  return { 'ok', existingMessageId, existingReservationId, '1', '1' }
end

if state == 'PENDING' then
  if existingHash ~= ARGV[2] then
    return { 'err', 'payload_mismatch' }
  end
  return { 'ok', existingMessageId, existingReservationId, '1', '0' }
end

local bal = tonumber(redis.call('GET', KEYS[2]) or '0')
local cost = tonumber(ARGV[3])
if bal < cost then
  return { 'err', 'insufficient' }
end

redis.call('DECRBY', KEYS[2], cost)
redis.call('HMSET', KEYS[1],
  'state', 'PENDING',
  'messageId', ARGV[1],
  'payloadHash', ARGV[2],
  'reservationId', ARGV[4],
  'cost', ARGV[3],
  'idemKey', ARGV[8]
)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
redis.call('HMSET', KEYS[4],
  'userId', ARGV[7],
  'messageId', ARGV[1],
  'cost', ARGV[3],
  'idemKey', ARGV[8]
)
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[6]))
redis.call('ZADD', KEYS[3], tonumber(ARGV[5]), ARGV[4])
return { 'ok', ARGV[1], ARGV[4], '0', '0' }
`;

/** KEYS[1]=idem  KEYS[2]=deadlines  KEYS[3]=reservation:{id}
 *  ARGV[1]=reservationId
 */
export const COMMIT_SMS_LUA = `
redis.call('HSET', KEYS[1], 'state', 'DONE')
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return 1
`;

/** KEYS[1]=idem KEYS[2]=wallet KEYS[3]=deadlines KEYS[4]=reservation
 *  ARGV[1]=reservationId ARGV[2]=cost
 *  returns 1 refunded, 0 noop
 */
export const REFUND_SMS_LUA = `
local state = redis.call('HGET', KEYS[1], 'state')
if state ~= 'PENDING' then
  return 0
end
redis.call('INCRBY', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('DEL', KEYS[4])
return 1
`;

/** Fixed-window rate limit.
 * KEYS[1]=rl:{userId}:{priority}:{window}
 * ARGV[1]=limit ARGV[2]=windowSec
 * returns { allowed(0|1), remaining, ttlSec }
 */
export const RATE_LIMIT_LUA = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], window)
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then ttl = window end
if n > limit then
  return { 0, 0, ttl }
end
return { 1, limit - n, ttl }
`;
