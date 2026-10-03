/**
 * End-to-end smoke for interview / clone-and-run.
 * Requires full stack (or API + workers + operator) on API_BASE.
 *
 *   npm run demo:smoke
 */
const API = process.env.API_BASE_URL ?? 'http://localhost:3000/v1';
const USER =
  process.env.USER_ID ?? '11111111-1111-1111-1111-111111111111';

async function req(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const health = await req('/health');
  if (health.status !== 200) {
    throw new Error(`health failed: HTTP ${health.status}`);
  }
  console.log('ok  health');

  const topup = await req(`/wallets/${USER}/topups`, {
    method: 'POST',
    body: JSON.stringify({ amount: 100 }),
  });
  if (topup.status !== 200 && topup.status !== 201) {
    throw new Error(`topup failed: HTTP ${topup.status} ${JSON.stringify(topup.json)}`);
  }
  console.log('ok  topup');

  const key = `smoke-${Date.now()}`;
  const send = await req('/sms', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({
      userId: USER,
      to: '+989121110001',
      body: 'demo smoke',
      priority: 'express',
    }),
  });
  if (send.status !== 202 || !send.json?.messageId) {
    throw new Error(`send failed: HTTP ${send.status} ${JSON.stringify(send.json)}`);
  }
  const messageId = send.json.messageId;
  console.log('ok  accepted', messageId);

  let last = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    last = await req(`/sms/${messageId}`);
    if (last.status === 200 && last.json?.status === 'delivered') {
      console.log(
        'ok  delivered',
        `latencyMs=${last.json.latencyMs ?? 'n/a'}`,
      );
      console.log('demo-smoke passed');
      return;
    }
  }

  throw new Error(
    `not delivered within timeout; last=${JSON.stringify(last?.json ?? last)}`,
  );
}

main().catch((err) => {
  console.error('demo-smoke failed:', err.message || err);
  process.exit(1);
});
