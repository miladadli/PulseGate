/**
 * Live stack tests — requires infra + api (+ ideally operator/worker/projector/ledger).
 * Run: npm run test:integration
 */
const API = process.env.API_BASE_URL ?? 'http://localhost:3000/v1';
const USER = '11111111-1111-1111-1111-111111111111';

async function api(
  path: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (init?.idempotencyKey) {
    headers['Idempotency-Key'] = init.idempotencyKey;
  }
  const res = await fetch(`${API}${path}`, { ...init, headers });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('PulseGate live integration', () => {
  let apiUp = false;

  beforeAll(async () => {
    try {
      const h = await api('/health');
      apiUp = h.status === 200;
    } catch {
      apiUp = false;
    }
    if (!apiUp) {
      console.warn(
        'API not reachable at',
        API,
        '— skipping integration tests',
      );
    }
  });

  const itLive = (name: string, fn: () => Promise<void>, timeout = 30000) =>
    it(name, async () => {
      if (!apiUp) return;
      await fn();
    }, timeout);

  itLive('health is ok', async () => {
    const { status, json } = await api('/health');
    expect(status).toBe(200);
    expect(json.postgres).toBe(true);
  });

  itLive('wallet returns spendable breakdown', async () => {
    const { status, json } = await api(`/wallets/${USER}`);
    expect(status).toBe(200);
    expect(json.userId).toBe(USER);
    expect(json).toHaveProperty('balance');
    expect(json).toHaveProperty('leasedOut');
    expect(json).toHaveProperty('redisResidual');
    expect(json).toHaveProperty('spendable');
  });

  itLive('send express SMS → 202 and early GET from accept-cache', async () => {
    const key = `it-early-${Date.now()}`;
    const send = await api('/sms', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify({
        userId: USER,
        to: '+989121110099',
        body: 'integration early get',
        priority: 'express',
      }),
    });
    expect(send.status).toBe(202);
    expect(send.json.status).toBe('accepted');
    expect(send.json.messageId).toBeTruthy();

    const early = await api(`/sms/${send.json.messageId}`);
    expect(early.status).toBe(200);
    expect(early.json.messageId).toBe(send.json.messageId);
    expect(early.json.status).toBe('accepted');
  });

  itLive('idempotent replay returns same messageId with replay=true', async () => {
    const key = `it-replay-${Date.now()}`;
    const body = {
      userId: USER,
      to: '+989121110088',
      body: 'integration replay',
      priority: 'express',
    };
    const first = await api('/sms', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(202);

    const second = await api('/sms', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(202);
    expect(second.json.messageId).toBe(first.json.messageId);
    expect(second.json.replay).toBe(true);
  });

  itLive('payload mismatch on same idem key → 409', async () => {
    const key = `it-mismatch-${Date.now()}`;
    const first = await api('/sms', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify({
        userId: USER,
        to: '+989121110077',
        body: 'original',
        priority: 'express',
      }),
    });
    expect(first.status).toBe(202);

    const bad = await api('/sms', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify({
        userId: USER,
        to: '+989121110077',
        body: 'changed',
        priority: 'express',
      }),
    });
    expect(bad.status).toBe(409);
    expect(bad.json.code).toBe('PAYLOAD_MISMATCH');
  });

  itLive('missing Idempotency-Key → 4xx', async () => {
    const res = await api('/sms', {
      method: 'POST',
      body: JSON.stringify({
        userId: USER,
        to: '+989121110066',
        body: 'no key',
        priority: 'express',
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  itLive(
    'projector eventually shows delivered (or accepted) in reports',
    async () => {
      const key = `it-report-${Date.now()}`;
      const send = await api('/sms', {
        method: 'POST',
        idempotencyKey: key,
        body: JSON.stringify({
          userId: USER,
          to: '+989121110055',
          body: 'integration report',
          priority: 'express',
        }),
      });
      expect(send.status).toBe(202);
      const messageId = send.json.messageId as string;

      let found: any = null;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const list = await api(
          `/reports/sms?userId=${USER}&limit=50`,
        );
        if (list.status === 200 && Array.isArray(list.json)) {
          found = list.json.find((r: any) => r.messageId === messageId);
          if (found && (found.status === 'delivered' || found.status === 'accepted')) {
            break;
          }
        }
      }
      expect(found).toBeTruthy();
      expect(found.priority).toBe('express');
    },
    45000,
  );

  itLive('unknown sms id → 404', async () => {
    const res = await api('/sms/00000000-0000-4000-8000-00000000dead');
    expect(res.status).toBe(404);
  });
});
