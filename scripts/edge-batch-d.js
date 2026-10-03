/**
 * Edge batch D: circuit breaker, operator down → retry, processing-lock crash window
 *   node scripts/edge-batch-d.js
 */
const { execSync } = require('child_process');
const Redis = require('ioredis');

const API = process.env.API_BASE_URL ?? 'http://localhost:3000/v1';
const USER = '11111111-1111-1111-1111-111111111111';

async function api(method, path, { body, headers } = {}) {
  const res = await fetch(`${API}${path}`, {
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

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function waitStatus(messageId, want, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const g = await api('GET', `/sms/${messageId}`);
    if (g.status === 200 && g.json?.status === want) return g;
    await sleep(500);
  }
  return api('GET', `/sms/${messageId}`);
}

function scaleExpress(n) {
  sh(
    `docker compose -f docker/docker-compose.yml --profile full up -d --scale worker-express=${n} --no-recreate worker-express`,
  );
}

function stopExpress() {
  try {
    const ids = sh(
      'docker ps --filter name=pulsegate-worker-express --format "{{.ID}}"',
    )
      .split(/\r?\n/)
      .filter(Boolean);
    for (const id of ids) sh(`docker stop ${id}`);
  } catch {
    /* ignore */
  }
}

function startExpress(n = 3) {
  scaleExpress(n);
}

async function main() {
  let failed = 0;
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: 1,
  });

  await api('POST', `/wallets/${USER}/topups`, { body: { amount: 20000 } });

  // Clear CB from prior runs (exact keys — avoid KEYS on loaded Redis)
  await redis.del(
    'cb:operator:express:state',
    'cb:operator:express:open_until',
    'cb:operator:express:failures',
    'cb:operator:express:probe',
  );

  // 16 Circuit breaker open → fail-fast (no deliver while open); after clear, new SMS delivers.
  // Note: a message already in-flight may hit maxAttempts→DLQ if CB stays open — that is expected.
  {
    const openMs = 30_000;
    const until = Date.now() + openMs;
    await redis
      .multi()
      .set('cb:operator:express:state', 'open', 'PX', openMs)
      .set('cb:operator:express:open_until', String(until), 'PX', openMs)
      .set('cb:operator:express:failures', '20')
      .exec();

    const keyBlocked = `edge-cb-block-${Date.now()}`;
    const blocked = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110401',
        body: 'cb open',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': keyBlocked },
    });
    await sleep(2000);
    const mid = await api('GET', `/sms/${blocked.json?.messageId}`);

    await redis.del(
      'cb:operator:express:state',
      'cb:operator:express:open_until',
      'cb:operator:express:failures',
      'cb:operator:express:probe',
    );

    const keyOk = `edge-cb-ok-${Date.now()}`;
    const after = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110411',
        body: 'cb closed',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': keyOk },
    });
    const delivered = await waitStatus(after.json?.messageId, 'delivered', 40);
    const ok =
      blocked.status === 202 &&
      mid.json?.status !== 'delivered' &&
      after.status === 202 &&
      delivered.json?.status === 'delivered';
    if (
      !pass(
        16,
        'CB open blocks deliver; after clear new SMS delivers',
        ok,
        `blockedMid=${mid.json?.status} newFinal=${delivered.json?.status} latencyMs=${delivered.json?.latencyMs}`,
      )
    )
      failed++;
  }
  // 15 Operator down → retry → deliver after operator back
  {
    sh('docker stop pulsegate-operator-sim-1');
    await sleep(1000);
    const key = `edge-opdown-${Date.now()}`;
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110402',
        body: 'op down',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    await sleep(3000);
    const mid = await api('GET', `/sms/${send.json?.messageId}`);
    sh('docker start pulsegate-operator-sim-1');
    // Clear CB that opened from operator failures
    await sleep(2000);
    await redis.del(
      'cb:operator:express:state',
      'cb:operator:express:open_until',
      'cb:operator:express:failures',
      'cb:operator:express:probe',
    );
    const end = await waitStatus(send.json?.messageId, 'delivered', 50);
    const ok =
      send.status === 202 &&
      mid.json?.status !== 'delivered' &&
      end.json?.status === 'delivered';
    if (
      !pass(
        15,
        'Operator down → retry → delivered',
        ok,
        `mid=${mid.json?.status} final=${end.json?.status} latencyMs=${end.json?.latencyMs}`,
      )
    )
      failed++;
  }

  // 13 Stale processing lock must not permanently skip (crash window)
  {
    stopExpress();
    await sleep(2000);
    const key = `edge-lock-${Date.now()}`;
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110403',
        body: 'stale lock',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const messageId = send.json?.messageId;
    // Simulate crash after acquiring processing lock
    await redis.set(`dispatch:done:${messageId}`, 'processing', 'PX', 15_000);
    startExpress(2);
    await sleep(4000);
    const mid = await api('GET', `/sms/${messageId}`);
    // After lock TTL, should still become delivered (re-consume or retry)
    const end = await waitStatus(messageId, 'delivered', 50);
    const ok =
      send.status === 202 &&
      end.json?.status === 'delivered';
    if (
      !pass(
        13,
        'Stale processing lock → eventually delivered',
        ok,
        `mid@4s=${mid.json?.status} final=${end.json?.status} latencyMs=${end.json?.latencyMs}`,
      )
    )
      failed++;
    startExpress(3);
  }

  // 14 Permanent done=1 without deliver is poison (should not happen on happy path);
  //    verify marker becomes 1 only after delivered
  {
    const key = `edge-done-${Date.now()}`;
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110404',
        body: 'done marker',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const messageId = send.json?.messageId;
    let sawProcessingOrEmpty = false;
    for (let i = 0; i < 40; i++) {
      const marker = await redis.get(`dispatch:done:${messageId}`);
      const g = await api('GET', `/sms/${messageId}`);
      if (g.json?.status === 'delivered') {
        const ok = marker === '1';
        if (
          !pass(
            14,
            'done=1 only after successful deliver',
            ok,
            `marker=${marker} status=${g.json?.status} sawPre=${sawProcessingOrEmpty}`,
          )
        )
          failed++;
        break;
      }
      if (marker === 'processing' || marker === null) sawProcessingOrEmpty = true;
      if (i === 39) {
        if (
          !pass(
            14,
            'done=1 only after successful deliver',
            false,
            `timeout marker=${marker} status=${g.json?.status}`,
          )
        )
          failed++;
      }
      await sleep(200);
    }
  }

  redis.disconnect();
  console.log('');
  console.log(
    failed === 0
      ? 'Batch D: all passed'
      : `Batch D: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
