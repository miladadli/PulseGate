# PulseGate Runbook & SLO

Operational guide for local demo and interview walkthrough.

## Stack

| Layer | How to run |
|-------|------------|
| Infra | `npm run infra:up` then `npm run db:setup` |
| API | `npm run api:dev` → http://localhost:3000/docs |
| Operator | `npm run operator:dev` |
| Workers | `npm run worker:express` (+ `normal` / `heavy` as needed) |
| Projector | `npm run projector:dev` |
| Ledger | `npm run ledger:dev` |
| Reconciler | `npm run reconciler:dev` |

Stop Node apps with Ctrl+C; infra with `npm run infra:down`.

## Metrics (lightweight Prometheus)

`GET /v1/metrics` — Prometheus text format (`prom-client`).  
OTel Collector can scrape this endpoint; full OTLP export is optional.

| Metric | Meaning |
|--------|---------|
| `pulsegate_http_request_duration_seconds` | HTTP latency histogram |
| `pulsegate_http_requests_total` | Request counter |
| `pulsegate_sms_admit_total{result=…}` | admit outcomes (`accepted` / `insufficient` / `rate_limited` / …) |

## Rate limit (HTTP 429)

Hard ceiling **before** Lua credit reserve:

| Priority | Default | Window |
|----------|---------|--------|
| express | 200 req/s/user | 1s |
| normal | 50 req/s/user | 1s |

Env: `RATE_LIMIT_EXPRESS`, `RATE_LIMIT_NORMAL`, `RATE_LIMIT_WINDOW_SEC`.

Response:

```json
{ "statusCode": 429, "code": "RATE_LIMITED", "retryAfterSec": 1 }
```

Header: `Retry-After: <seconds>`

Fairness (heavy topic) is separate — 429 is the emergency valve.

## Circuit breaker (operator)

Workers share Redis keys `cb:operator:{mode}:*`.

| Setting | Default | Env |
|---------|---------|-----|
| Failure threshold | 5 | `CB_FAILURE_THRESHOLD` |
| Open duration | 10s | `CB_OPEN_MS` |

States: `closed` → accumulate failures → `open` (fail-fast, messages go retry/DLQ with `circuit_open`) → `half_open` probe → success closes.

## SLO (Express)

**Objective:** P99 of `accepted_at` → operator ack (field `latency_ms` on delivered reports) **&lt; 500ms**.

Worker stores **end-to-end** latency: `ackAt - Date.parse(acceptedAt)` (not just operator HTTP RTT).

### How to measure (ClickHouse)

After sending express SMS with projector + worker up:

```bash
docker exec pulsegate-clickhouse-1 clickhouse-client --password pulsegate -q "
SELECT
  count() AS n,
  quantile(0.50)(latency_ms) AS p50,
  quantile(0.95)(latency_ms) AS p95,
  quantile(0.99)(latency_ms) AS p99,
  max(latency_ms) AS max_ms
FROM pulsegate.sms_reports FINAL
WHERE priority = 'express'
  AND status = 'delivered'
  AND latency_ms IS NOT NULL
"
```

**How to measure fairly:** use a quiet window (low Kafka lag), or filter `accepted_at` to after lag drained. Flooding admit (k6) with one consumer replica will inflate `latency_ms` — that is backlog, not Lua/API latency.

**Local baseline (quiet path, operator-sim):** single express SMS after workers healthy → `latency_ms` typically tens of ms (target P99 &lt; 500ms under non-backlogged load).

`npm run full:up` scales `worker-express=3` and `worker-normal=2` so dispatch can keep up better on a laptop demo.

### Admit load (k6)

k6 measures **HTTP admit** only (not operator e2e). Top-up first:

```bash
npm run test:k6
# or: node scripts/run-k6.js run -e VUS=10 -e DURATION=20s -e REQUIRE_CREDIT=1 scripts/k6/sms-load.js
```

**Measured (local, 10 VUs / 20s / express, after top-up):**

| Metric | Value |
|--------|-------|
| iterations | ~3500 (~175/s) |
| admit_ok | 100% |
| http_req_failed | 0% |
| http_req_duration p95 | ~14ms |
| admit_latency_ms avg | ~7ms |

### SLI definition

| SLI | Source |
|-----|--------|
| Express operator latency | `sms_reports.latency_ms` where `priority=express` and `status=delivered` |
| Admit availability | API 2xx / (2xx+5xx) excluding 429 budget |
| Credit correctness | no negative wallet; settle lag via `kafka_offsets` |

## Failure playbook

| Symptom | Check | Action |
|---------|-------|--------|
| 402 | Redis residual + PG balance | Top-up; wait lease refill |
| 429 | Rate keys `rl:{userId}:*` | Back off / raise env limits |
| SMS stuck accepted | worker/operator logs; Redis `dispatch:done:{id}` | If value is `processing`, wait ≤2m or `DEL` key + replay; if `1` without deliver, operator may have acked—check `sms.status` / CH. Cold-start: workers retry topic create and `restart: unless-stopped` |
| Reports empty | projector logs / CH | `npm run projector:dev`; wait FINAL |
| Balance not dropping in PG | ledger | `npm run ledger:dev`; check `wallet_ledger` |
| Operator storms | CB open | Wait `CB_OPEN_MS`; fix operator; watch `cb:operator:*` |
| Redis residual wrong / flush | AOF / keys | `npm run redis:rebuild` (conservative; admits paused via `admit:paused`) |
| Pending reservations | reconciler | `npm run reconciler:dev` |

## Retention / RTO (declared)

| Store | Retention / RTO note |
|-------|----------------------|
| Kafka | Keep ≥ settle lag + Redis RTO + margin (local: default broker retention) |
| Redis | AOF on; rebuild prefers conservative lockup over overspend (§4.6) |
| ClickHouse | Partition by day; query with `FINAL` |
| Postgres | SoR; restore from backup → run migrations → seed if empty |

## Redis rebuild (§4.6 conservative)

After Redis flush/crash (or intentional residual wipe):

```bash
npm run redis:rebuild
```

Sets `admit:paused` during rebuild, zeroes every wallet residual (overspend bound = 0), re-applies `wallet_leases` still `pending`, then clears the pause. Prefer lockup over overspend; Kafka exact-replay rebuild is deferred.

## Clone-and-run (Docker full)

```bash
npm run full:up    # infra + migrate/seed + apps; scales express×3 normal×2
npm run demo:smoke # prove accept → delivered
npm run full:down
```

Host apps talk to Kafka on `localhost:9092`; containers use `kafka:29092` (dual listeners). Do not mix host Nest processes with `full` profile on the same ports (3000/3010).

## Interview walkthrough (≈5 min)

1. `npm run full:up` → open Swagger http://localhost:3000/docs  
2. Top-up demo-light → send express SMS → GET by id shows `delivered` + `latencyMs`  
3. Diagram: admit = Redis Lua + Kafka only; lease/settle/reconciler off hot path  
4. Show `/v1/metrics` + ClickHouse P99 query (quiet window)  
5. Say plainly: design target ~100M/day; local proof is admit k6 + e2e smoke, not prod soak  

## Tests

```bash
npm test
npm run test:integration   # needs live API (+ stack)
npm run demo:smoke         # accept → delivered (needs workers + operator)
npm run verify             # unit + integration + demo:smoke
npm run test:k6            # needs https://k6.io + API up
# VUS=10 DURATION=20s REQUIRE_CREDIT=1 npm run test:k6
```
