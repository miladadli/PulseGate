/**
 * Edge batch E: routing (express/heavy), admit paused, redis rebuild
 *   node scripts/edge-batch-e.js
 */
const { execSync } = require('child_process');
const Redis = require('ioredis');

const API = process.env.API_BASE_URL ?? 'http://localhost:3000/v1';
const USER = '11111111-1111-1111-1111-111111111111';
const HEAVY_USER = '22222222-2222-2222-2222-222222222222';

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
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  let failed = 0;
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: 1,
  });

  await api('POST', `/wallets/${USER}/topups`, { body: { amount: 50000 } });
  await api('POST', `/wallets/${HEAVY_USER}/topups`, {
    body: { amount: 50000 },
  });
  await redis.del('admit:paused');

  // 19 Express never routes to heavy
  {
    const bucket = Math.floor(Date.now() / 1000 / 10);
    await redis.del(`ratewin:${USER}:${bucket}`, `heavy:${USER}`);
    // Pre-mark heavy flag — express must still ignore it
    await redis.set(`heavy:${USER}`, '1', 'EX', 60);
    const topics = [];
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/sms', {
        body: {
          userId: USER,
          to: '+989121110501',
          body: `express ${i}`,
          priority: 'express',
        },
        headers: { 'Idempotency-Key': `edge-ex-${Date.now()}-${i}` },
      });
      topics.push(r.json?.topic);
    }
    const ok =
      topics.length === 5 && topics.every((t) => t === 'sms.express');
    if (
      !pass(
        19,
        'Express always sms.express',
        ok,
        `topics=${JSON.stringify(topics)}`,
      )
    )
      failed++;
    await redis.del(`heavy:${USER}`);
  }

  // 20 Normal → heavy after threshold (default 50 / 10s)
  {
    const bucket = Math.floor(Date.now() / 1000 / 10);
    await redis.del(`ratewin:${HEAVY_USER}:${bucket}`, `heavy:${HEAVY_USER}`);
    // Clear RL window keys for this user (exact current second buckets)
    const win = Math.floor(Date.now() / 1000);
    await redis.del(
      `rl:${HEAVY_USER}:normal:${win}`,
      `rl:${HEAVY_USER}:normal:${win - 1}`,
    );

    let firstHeavyAt = -1;
    const topics = [];
    // Stay under normal rate limit (50/s): send ~45 with tiny spacing, then burst to 55
    for (let i = 0; i < 55; i++) {
      const r = await api('POST', '/sms', {
        body: {
          userId: HEAVY_USER,
          to: '+989121110502',
          body: `normal ${i}`,
          priority: 'normal',
        },
        headers: { 'Idempotency-Key': `edge-hv-${Date.now()}-${i}` },
      });
      if (r.status === 429) {
        await sleep(1100);
        const retry = await api('POST', '/sms', {
          body: {
            userId: HEAVY_USER,
            to: '+989121110502',
            body: `normal ${i}`,
            priority: 'normal',
          },
          headers: { 'Idempotency-Key': `edge-hv-retry-${Date.now()}-${i}` },
        });
        topics.push(retry.json?.topic ?? `HTTP_${retry.status}`);
        if (retry.json?.topic === 'sms.heavy' && firstHeavyAt < 0) {
          firstHeavyAt = topics.length;
        }
      } else {
        topics.push(r.json?.topic ?? `HTTP_${r.status}`);
        if (r.json?.topic === 'sms.heavy' && firstHeavyAt < 0) {
          firstHeavyAt = topics.length;
        }
      }
    }
    const heavyCount = topics.filter((t) => t === 'sms.heavy').length;
    const normalCount = topics.filter((t) => t === 'sms.normal').length;
    const ok = heavyCount >= 1 && normalCount >= 1 && firstHeavyAt >= 45;
    if (
      !pass(
        20,
        'Normal routes to heavy after threshold',
        ok,
        `firstHeavyAt=${firstHeavyAt} normal=${normalCount} heavy=${heavyCount} sample=${JSON.stringify(topics.slice(45, 55))}`,
      )
    )
      failed++;
  }

  // 21 Heavy per-tenant gap — same Redis NX pattern workers use (default 20ms)
  {
    const gapMs = 20;
    const key = `dispatch:gap:${HEAVY_USER}`;
    await redis.del(key);
    const t0 = Date.now();
    const a = await redis.set(key, '1', 'PX', gapMs, 'NX');
    const b = await redis.set(key, '1', 'PX', gapMs, 'NX');
    await sleep(gapMs + 5);
    const c = await redis.set(key, '1', 'PX', gapMs, 'NX');
    const ok = a === 'OK' && b === null && c === 'OK';
    if (
      !pass(
        21,
        'Heavy per-tenant gap lock (NX)',
        ok,
        `a=${a} b=${b} c=${c} elapsed=${Date.now() - t0}ms`,
      )
    )
      failed++;
  }

  // 6 Admit paused → 503 ADMIT_PAUSED
  {
    await redis.set('admit:paused', '1');
    const blocked = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110503',
        body: 'paused',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': `edge-pause-${Date.now()}` },
    });
    await redis.del('admit:paused');
    const okAgain = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110504',
        body: 'unpaused',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': `edge-unpause-${Date.now()}` },
    });
    const ok =
      blocked.status === 503 &&
      blocked.json?.code === 'ADMIT_PAUSED' &&
      okAgain.status === 202;
    if (
      !pass(
        6,
        'Admit paused → 503 then resume',
        ok,
        `blocked=${blocked.status}/${blocked.json?.code} resume=${okAgain.status}`,
      )
    )
      failed++;
  }

  // 30 Conservative redis rebuild — residuals zeroed then spendable again after topup
  {
    // Put a known residual, then rebuild
    await redis.set(`wallet:${USER}:balance`, '999');
    await redis.set(`wallet:${HEAVY_USER}:balance`, '888');
    let report = '';
    try {
      report = sh('npm run redis:rebuild').toString();
    } catch (err) {
      report = String(err.stdout || err.message || err);
    }
    const r1 = await redis.get(`wallet:${USER}:balance`);
    const r2 = await redis.get(`wallet:${HEAVY_USER}:balance`);
    const pausedGone = (await redis.get('admit:paused')) !== '1';
    // After conservative rebuild residual is 0 unless pending grants re-applied
    const top = await api('POST', `/wallets/${USER}/topups`, {
      body: { amount: 1000 },
    });
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110505',
        body: 'after rebuild',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': `edge-rebuild-${Date.now()}` },
    });
    const ok =
      pausedGone &&
      Number(r1) !== 999 &&
      Number(r2) !== 888 &&
      top.status === 200 &&
      send.status === 202 &&
      /conservative|residualsZeroed|Redis rebuild/i.test(report);
    if (
      !pass(
        30,
        'Redis rebuild conservative + admit works',
        ok,
        `residualLight=${r1} residualHeavy=${r2} top=${top.status} send=${send.status} pausedCleared=${pausedGone}`,
      )
    )
      failed++;
  }

  redis.disconnect();
  console.log('');
  console.log(
    failed === 0
      ? 'Batch E: all passed'
      : `Batch E: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
