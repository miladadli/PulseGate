/**
 * Edge batch B: early GET cache, deliver+latency, 404, kill one express worker
 *   node scripts/edge-batch-b.js
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
  await api('POST', `/wallets/${USER}/topups`, { body: { amount: 5000 } });

  // 22 Early GET from accept-cache
  {
    const key = `edge-early-${Date.now()}`;
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110201',
        body: 'early get',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const get = await api('GET', `/sms/${send.json?.messageId}`);
    const ok =
      send.status === 202 &&
      get.status === 200 &&
      get.json?.messageId === send.json?.messageId &&
      (get.json?.status === 'accepted' || get.json?.status === 'delivered');
    if (
      !pass(
        22,
        'GET immediately after accept',
        ok,
        `send=${send.status} get=${get.status} status=${get.json?.status}`,
      )
    )
      failed++;
  }

  // 23 Delivered + latencyMs
  {
    const key = `edge-deliv-${Date.now()}`;
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110202',
        body: 'wait deliver',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': key },
    });
    const get = await waitDelivered(send.json?.messageId);
    const ok =
      send.status === 202 &&
      get.json?.status === 'delivered' &&
      typeof get.json?.latencyMs === 'number' &&
      get.json.latencyMs >= 0 &&
      get.json.latencyMs < 60_000;
    if (
      !pass(
        23,
        'GET after deliver + latencyMs',
        ok,
        `status=${get.json?.status} latencyMs=${get.json?.latencyMs}`,
      )
    )
      failed++;
  }

  // 24 Unknown id → 404
  {
    const get = await api(
      'GET',
      '/sms/00000000-0000-4000-8000-00000000dead',
    );
    const ok = get.status === 404;
    if (
      !pass(24, 'Unknown messageId → 404', ok, `status=${get.status}`)
    )
      failed++;
  }

  // 29 Kill one worker-express; another should deliver
  {
    let container = '';
    try {
      container = sh(
        'docker ps --filter name=pulsegate-worker-express --format "{{.ID}}" -q',
      )
        .split(/\r?\n/)
        .filter(Boolean)[0];
    } catch {
      container = '';
    }
    if (!container) {
      if (!pass(29, 'Kill one express worker', false, 'no worker-express container'))
        failed++;
    } else {
      const before = sh(
        'docker ps --filter name=pulsegate-worker-express --format "{{.ID}}"',
      )
        .split(/\r?\n/)
        .filter(Boolean).length;
      sh(`docker kill ${container}`);
      // compose restart:unless-stopped should bring a replacement; wait briefly
      await sleep(3000);
      const key = `edge-kill-${Date.now()}`;
      const send = await api('POST', '/sms', {
        body: {
          userId: USER,
          to: '+989121110203',
          body: 'after kill',
          priority: 'express',
        },
        headers: { 'Idempotency-Key': key },
      });
      const get = await waitDelivered(send.json?.messageId, 60);
      const after = sh(
        'docker ps --filter name=pulsegate-worker-express --format "{{.ID}}"',
      )
        .split(/\r?\n/)
        .filter(Boolean).length;
      const ok =
        send.status === 202 &&
        get.json?.status === 'delivered' &&
        after >= 1;
      if (
        !pass(
          29,
          'Kill one express worker → still delivers',
          ok,
          `killed=${container.slice(0, 12)} before=${before} after=${after} status=${get.json?.status} latencyMs=${get.json?.latencyMs}`,
        )
      )
        failed++;
    }
  }

  console.log('');
  console.log(
    failed === 0
      ? 'Batch B: all passed'
      : `Batch B: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
