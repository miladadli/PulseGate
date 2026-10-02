/**
 * PulseGate SMS admit load test (k6).
 *
 * 402 = insufficient credit (expected after heavy runs — top-up first)
 * 429 = rate limit (expected under aggressive VUs)
 * 5xx = real failure
 *
 *   npm run test:k6
 *   k6 run -e VUS=20 -e DURATION=30s scripts/k6/sms-load.js
 *
 * Top-up demo user before a “must accept” run:
 *   POST /v1/wallets/11111111-1111-1111-1111-111111111111/topups  {"amount":50000}
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.API_BASE || 'http://localhost:3000/v1';
const USER =
  __ENV.USER_ID || '11111111-1111-1111-1111-111111111111';
const PRIORITY = __ENV.PRIORITY || 'express';
/** If 1, fail the run when admit_ok drops (needs enough wallet credit). */
const REQUIRE_CREDIT = __ENV.REQUIRE_CREDIT === '1';

const admitOk = new Rate('admit_ok');
const admit429 = new Rate('admit_429');
const admit402 = new Rate('admit_402');
const businessOk = new Rate('business_ok');
const admitLatency = new Trend('admit_latency_ms', true);

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '20s',
  thresholds: {
    // Only real transport/5xx count as failed (see expectedStatuses below)
    http_req_failed: ['rate<0.05'],
    business_ok: ['rate>0.95'],
    http_req_duration: ['p(95)<200'],
    ...(REQUIRE_CREDIT ? { admit_ok: ['rate>0.7'] } : {}),
  },
};

export function setup() {
  // 202/402/429 are valid API outcomes — do not mark as http_req_failed
  http.setResponseCallback(
    http.expectedStatuses(202, 402, 429),
  );
}

export default function () {
  const key = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({
    userId: USER,
    to: `+98912${String(__VU).padStart(3, '0')}${String(__ITER % 10000).padStart(4, '0')}`,
    body: `k6 load ${__VU}/${__ITER}`,
    priority: PRIORITY,
  });

  const res = http.post(`${BASE}/sms`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    tags: { name: 'POST /v1/sms' },
  });

  admitLatency.add(res.timings.duration);
  admitOk.add(res.status === 202);
  admit429.add(res.status === 429);
  admit402.add(res.status === 402);
  businessOk.add(
    res.status === 202 || res.status === 429 || res.status === 402,
  );

  check(res, {
    'accepted or expected business code': (r) =>
      r.status === 202 || r.status === 429 || r.status === 402,
  });

  sleep(Number(__ENV.SLEEP || 0.05));
}
