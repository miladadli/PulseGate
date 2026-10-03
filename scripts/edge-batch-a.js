/**
 * Edge batch A: idempotency, mismatch, missing key, 402, 429
 *   node scripts/edge-batch-a.js
 */
const { execSync } = require('child_process');

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
  return { status: res.status, json, headers: res.headers };
}

function pass(id, name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${id} ${name} — ${detail}`);
  return ok;
}

async function main() {
  let failed = 0;

  await api('POST', `/wallets/${USER}/topups`, { body: { amount: 5000 } });

  // 1 Idempotency replay
  {
    const key = `edge-idem-${Date.now()}`;
    const body = {
      userId: USER,
      to: '+989121110101',
      body: 'edge idem',
      priority: 'express',
    };
    const a = await api('POST', '/sms', {
      body,
      headers: { 'Idempotency-Key': key },
    });
    const b = await api('POST', '/sms', {
      body,
      headers: { 'Idempotency-Key': key },
    });
    const ok =
      a.status === 202 &&
      b.status === 202 &&
      a.json?.messageId === b.json?.messageId &&
      b.json?.replay === true;
    if (
      !pass(
        1,
        'Idempotency replay',
        ok,
        `first=${a.status} second=${b.status} sameId=${a.json?.messageId === b.json?.messageId} replay=${b.json?.replay}`,
      )
    )
      failed++;
  }

  // 2 Payload mismatch
  {
    const key = `edge-mm-${Date.now()}`;
    const a = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110102',
        body: 'original',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const b = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110102',
        body: 'changed',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const ok =
      a.status === 202 &&
      b.status === 409 &&
      b.json?.code === 'PAYLOAD_MISMATCH';
    if (
      !pass(
        2,
        'Payload mismatch → 409',
        ok,
        `first=${a.status} second=${b.status} code=${b.json?.code}`,
      )
    )
      failed++;
  }

  // 3 Missing key
  {
    const a = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110103',
        body: 'no key',
        priority: 'express',
      },
    });
    const ok = a.status >= 400 && a.status < 500;
    if (
      !pass(
        3,
        'Missing Idempotency-Key → 4xx',
        ok,
        `status=${a.status} code=${a.json?.code}`,
      )
    )
      failed++;
  }

  // 4 Insufficient credit → 402
  {
    execSync(
      `docker exec pulsegate-redis-1 redis-cli SET wallet:${USER}:balance 0`,
      { stdio: 'ignore' },
    );
    execSync(
      `docker exec pulsegate-postgres-1 psql -U pulsegate -d pulsegate -c "UPDATE wallets SET balance = leased_out WHERE user_id = '${USER}';"`,
      { stdio: 'ignore' },
    );
    const a = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110104',
        body: 'no credit',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': `edge-402-${Date.now()}` },
    });
    const ok = a.status === 402;
    if (
      !pass(
        4,
        'Insufficient credit → 402',
        ok,
        `status=${a.status} code=${a.json?.code}`,
      )
    )
      failed++;
    await api('POST', `/wallets/${USER}/topups`, { body: { amount: 50000 } });
  }

  // 5 Rate limit → 429 (burst > 200/s express)
  {
    const n = 280;
    const started = Date.now();
    const reqs = Array.from({ length: n }, (_, i) =>
      api('POST', '/sms', {
        body: {
          userId: USER,
          to: '+989121110199',
          body: `rl ${i}`,
          priority: 'express',
        },
        headers: { 'Idempotency-Key': `edge-rl-${started}-${i}` },
      }),
    );
    const outs = await Promise.all(reqs);
    const counts = outs.reduce((m, r) => {
      m[r.status] = (m[r.status] || 0) + 1;
      return m;
    }, {});
    const ok = (counts[429] || 0) > 0;
    if (
      !pass(
        5,
        'Rate limit → 429',
        ok,
        `counts=${JSON.stringify(counts)} elapsedMs=${Date.now() - started}`,
      )
    )
      failed++;
  }

  console.log('');
  console.log(
    failed === 0
      ? 'Batch A: all passed'
      : `Batch A: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
