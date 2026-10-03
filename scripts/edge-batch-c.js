/**
 * Edge batch C: concurrent admit race, settle after deliver, TTL lockup (no refund)
 *   node scripts/edge-batch-c.js
 */
const { execSync } = require('child_process');
const path = require('path');
const Redis = require('ioredis');

const API = process.env.API_BASE_URL ?? 'http://localhost:3000/v1';
const USER = '11111111-1111-1111-1111-111111111111';

async function api(method, pathName, { body, headers } = {}) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pass(id, name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${id} ${name} — ${detail}`);
  return ok;
}

async function waitDelivered(messageId, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const g = await api('GET', `/sms/${messageId}`);
    if (g.status === 200 && g.json?.status === 'delivered') return g;
    await sleep(500);
  }
  return api('GET', `/sms/${messageId}`);
}

async function main() {
  let failed = 0;

  // Ensure libs built for direct store access
  try {
    require.resolve('@pulsegate/infrastructure');
  } catch {
    execSync('npm run build:libs', { stdio: 'inherit' });
  }
  const { RedisCreditStore } = require('@pulsegate/infrastructure');

  await api('POST', `/wallets/${USER}/topups`, { body: { amount: 20000 } });

  // 8 Concurrent Lua admits — no lease refill; residual never negative; oks ≤ before
  {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: 1,
    });
    const store = new RedisCreditStore(redis);
    const walletKey = `wallet:${USER}:balance`;
    const before = 40;
    await redis.set(walletKey, String(before));
    const n = 60;
    const started = Date.now();
    const outs = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.admitSms({
          userId: USER,
          idempotencyKey: `edge-race-${started}-${i}`,
          messageId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`,
          payloadHash: `h-${i}`,
          cost: 1n,
          reservationTtlSec: 60,
        }),
      ),
    );
    const nOk = outs.filter((r) => r.status === 'ok').length;
    const nInsuff = outs.filter((r) => r.status === 'insufficient').length;
    const after = Number(await redis.get(walletKey));
    const ok =
      after >= 0 &&
      after === before - nOk &&
      nOk === before &&
      nInsuff === n - before;
    if (
      !pass(
        8,
        'Concurrent Lua admit race (exact residual)',
        ok,
        `before=${before} after=${after} ok=${nOk} insufficient=${nInsuff}`,
      )
    )
      failed++;
    // Refund PENDING so reconciler does not ttl-lockup the race leftovers.
    for (let i = 0; i < n; i++) {
      const r = outs[i];
      if (r.status === 'ok' && r.reservationId) {
        await store.refund({
          userId: USER,
          idempotencyKey: `edge-race-${started}-${i}`,
          reservationId: r.reservationId,
          cost: 1n,
        });
      }
    }
    redis.disconnect();
    await api('POST', `/wallets/${USER}/topups`, { body: { amount: 10000 } });
  }

  // 26 Settle after deliver — settled flag / PG wallet moves over time
  {
    const before = await api('GET', `/wallets/${USER}`);
    const key = `edge-settle-${Date.now()}`;
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110302',
        body: 'settle me',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const deliv = await waitDelivered(send.json?.messageId);
    let settledRedis = '0';
    let pgMoved = false;
    for (let i = 0; i < 30; i++) {
      settledRedis = execSync(
        `docker exec pulsegate-redis-1 redis-cli GET settled:${send.json.messageId}`,
        { encoding: 'utf8' },
      ).trim();
      const w = await api('GET', `/wallets/${USER}`);
      // leasedOut or balance should not stay identical forever after settle; residual should drop
      if (
        settledRedis === '1' ||
        Number(w.json?.redisResidual) < Number(before.json?.redisResidual)
      ) {
        pgMoved = true;
        break;
      }
      await sleep(500);
    }
    const ok =
      send.status === 202 &&
      deliv.json?.status === 'delivered' &&
      (settledRedis === '1' || pgMoved);
    if (
      !pass(
        26,
        'Settle after deliver',
        ok,
        `delivered=${deliv.json?.status} settledRedis=${settledRedis} residualBefore=${before.json?.redisResidual}`,
      )
    )
      failed++;
  }

  // 10 TTL lockup — PENDING expired → commit (not refund); residual stays reduced
  {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: 1,
    });
    const store = new RedisCreditStore(redis);
    const walletKey = `wallet:${USER}:balance`;
    await redis.set(walletKey, '25');
    const idem = `edge-ttl-${Date.now()}`;
    const messageId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001';
    const admit = await store.admitSms({
      userId: USER,
      idempotencyKey: idem,
      messageId,
      payloadHash: 'ttl-hash',
      cost: 1n,
      reservationTtlSec: 1,
    });
    if (admit.status !== 'ok') {
      if (!pass(10, 'TTL lockup (no auto-refund)', false, `admit=${admit.status}`))
        failed++;
    } else {
      const afterAdmit = Number(await redis.get(walletKey));
      // Force deadline into the past so reconciler can pick it up immediately
      await redis.zadd(
        'reservations:deadlines',
        Date.now() - 1000,
        admit.reservationId,
      );
      let state = 'PENDING';
      for (let i = 0; i < 40; i++) {
        state = (await redis.hget(`idem:${USER}:${idem}`, 'state')) || state;
        if (state === 'DONE') break;
        await sleep(500);
      }
      const after = Number(await redis.get(walletKey));
      const ok = state === 'DONE' && after === afterAdmit && after === 24;
      if (
        !pass(
          10,
          'TTL lockup (no auto-refund)',
          ok,
          `state=${state} residualAfterAdmit=${afterAdmit} residualFinal=${after}`,
        )
      )
        failed++;
    }
    redis.disconnect();
  }

  // 11 Refund PENDING (produce-fail path) via store
  {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: 1,
    });
    const store = new RedisCreditStore(redis);
    await redis.set(`wallet:${USER}:balance`, '10');
    const idem = `edge-refund-${Date.now()}`;
    const admit = await store.admitSms({
      userId: USER,
      idempotencyKey: idem,
      messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002',
      payloadHash: 'rf',
      cost: 1n,
      reservationTtlSec: 60,
    });
    const outcome = await store.refund({
      userId: USER,
      idempotencyKey: idem,
      reservationId: admit.reservationId,
      cost: 1n,
    });
    const residual = await redis.get(`wallet:${USER}:balance`);
    const noop = await store.refund({
      userId: USER,
      idempotencyKey: idem,
      reservationId: admit.reservationId,
      cost: 1n,
    });
    const ok =
      admit.status === 'ok' &&
      outcome === 'refunded' &&
      residual === '10' &&
      noop === 'noop';
    if (
      !pass(
        11,
        'Refund PENDING + second refund noop',
        ok,
        `admit=${admit.status} refund=${outcome} residual=${residual} second=${noop}`,
      )
    )
      failed++;
    redis.disconnect();
  }

  console.log('');
  console.log(
    failed === 0
      ? 'Batch C: all passed'
      : `Batch C: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
