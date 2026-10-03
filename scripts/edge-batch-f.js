/**
 * Edge batch F: #7 kafka produce fail refund, #27 double-settle, #31 full restart
 *   node scripts/edge-batch-f.js
 *
 * #31 restarts the full compose stack — expect a few minutes.
 */
const { execSync } = require('child_process');
const Redis = require('ioredis');

const API = process.env.API_BASE_URL ?? 'http://localhost:3000/v1';
const USER = '11111111-1111-1111-1111-111111111111';
const COMPOSE = 'docker compose -f docker/docker-compose.yml --profile full';

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

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

async function waitApi(tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const h = await api('GET', '/health');
      if (h.status === 200) return true;
    } catch {
      /* ignore */
    }
    await sleep(2000);
  }
  return false;
}

async function main() {
  let failed = 0;

  // Ensure libs for #27
  try {
    require.resolve('@pulsegate/infrastructure');
  } catch {
    sh('npm run build:libs', { inherit: true });
  }
  const {
    AppDataSource,
    TypeOrmWalletRepository,
  } = require('@pulsegate/infrastructure');

  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: 1,
  });

  await api('POST', `/wallets/${USER}/topups`, { body: { amount: 10000 } });

  // 7 Kafka down after reserve → 503. Ambiguous produce does NOT refund
  // (lockup > overspend); residual drops by 1 and stays PENDING / later TTL-commit.
  {
    const before = Number(await redis.get(`wallet:${USER}:balance`));
    sh('docker stop pulsegate-kafka-1');
    await sleep(1500);
    const send = await api('POST', '/sms', {
      body: {
        userId: USER,
        to: '+989121110601',
        body: 'kafka down',
        priority: 'express',
      },
      headers: { 'Idempotency-Key': `edge-kdown-${Date.now()}` },
    });
    const after = Number(await redis.get(`wallet:${USER}:balance`));
    sh('docker start pulsegate-kafka-1');
    for (let i = 0; i < 30; i++) {
      try {
        const st = sh(
          'docker inspect -f "{{.State.Health.Status}}" pulsegate-kafka-1',
        ).trim();
        if (st === 'healthy') break;
      } catch {
        /* ignore */
      }
      await sleep(2000);
    }
    await sleep(3000);
    const ok =
      send.status === 503 &&
      (send.json?.code === 'INGEST_FAILED' ||
        /ingest|kafka/i.test(String(send.json?.message ?? send.json?.error ?? ''))) &&
      after === before - 1;
    if (
      !pass(
        7,
        'Kafka produce fail → 503 + residual lockup (no refund)',
        ok,
        `status=${send.status} code=${send.json?.code} before=${before} after=${after}`,
      )
    )
      failed++;
  }
  // 27 Double settle is idempotent (second batch skips) — hit PG settle API directly
  {
    const messageId = `cccccccc-cccc-4ccc-8ccc-${Date.now().toString().slice(-12).padStart(12, '0')}`;
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    const wallets = new TypeOrmWalletRepository(AppDataSource);
    const first = await wallets.settleAcceptedBatch({
      batchId: `edge-dup-1-${Date.now()}`,
      debits: [{ userId: USER, messageId, cost: 1n }],
      offsets: [],
    });
    const second = await wallets.settleAcceptedBatch({
      batchId: `edge-dup-2-${Date.now()}`,
      debits: [{ userId: USER, messageId, cost: 1n }],
      offsets: [],
    });
    const count = sh(
      `docker exec pulsegate-postgres-1 psql -U pulsegate -d pulsegate -t -A -c "SELECT count(*) FROM wallet_ledger WHERE entry_type = 'lease_settle' AND ref_id = '${messageId}';"`,
    ).trim();

    const ok =
      first.settledMessageIds.includes(messageId) &&
      second.skippedMessageIds.includes(messageId) &&
      Number(count) === 1;
    if (
      !pass(
        27,
        'Double settle skipped; single lease_settle row',
        ok,
        `firstSettled=${JSON.stringify(first.settledMessageIds)} secondSkip=${JSON.stringify(second.skippedMessageIds)} pgCount=${count}`,
      )
    )
      failed++;

    await AppDataSource.destroy();
  }
  redis.disconnect();

  // 31 Full restart clone-and-run smoke (skip with SKIP_FULL_RESTART=1)
  if (process.env.SKIP_FULL_RESTART === '1') {
    pass(31, 'Full restart → accept → delivered', true, 'skipped (already verified)');
  } else {
    console.log('… full:down + full:up (this takes a bit)');
    try {
      sh(`${COMPOSE} down`, { inherit: false });
    } catch {
      /* ignore */
    }
    sh(
      `${COMPOSE} up --build -d --scale worker-express=3 --scale worker-normal=2`,
      { inherit: true },
    );
    const up = await waitApi(120);
    if (!up) {
      if (!pass(31, 'Full restart smoke', false, 'API never became healthy'))
        failed++;
    } else {
      await api('POST', `/wallets/${USER}/topups`, { body: { amount: 5000 } });
      const send = await api('POST', '/sms', {
        body: {
          userId: USER,
          to: '+989121110603',
          body: 'after full restart',
          priority: 'express',
        },
        headers: { 'Idempotency-Key': `edge-restart-${Date.now()}` },
      });
      let final = null;
      for (let i = 0; i < 60; i++) {
        final = await api('GET', `/sms/${send.json?.messageId}`);
        if (final.json?.status === 'delivered') break;
        await sleep(500);
      }
      const ok =
        send.status === 202 && final?.json?.status === 'delivered';
      if (
        !pass(
          31,
          'Full restart → accept → delivered',
          ok,
          `send=${send.status} status=${final?.json?.status} latencyMs=${final?.json?.latencyMs}`,
        )
      )
        failed++;
    }
  }
  console.log('');
  console.log(
    failed === 0
      ? 'Batch F: all passed'
      : `Batch F: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
