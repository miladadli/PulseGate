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

**Local measured baseline (operator-sim, after k6 express load):**  
Previously measured under RTT-only metric; after e2e fix re-measure with the ClickHouse query above. Target remains P99 &lt; 500ms.

### Admit load (k6)

```bash
# Top-up first, then:
npm run test:k6 -- run -e VUS=10 -e DURATION=20s -e PRIORITY=express -e REQUIRE_CREDIT=1 scripts/k6/sms-load.js
```

**Measured (local, 10 VUs / 20s / express, REQUIRE_CREDIT=1):**

| Metric | Value |
|--------|-------|
| iterations | ~3400 (~170/s) |
| admit_ok | 100% |
| http_req_failed | 0% |
| http_req_duration p95 | ~12ms |
| admit_latency_ms avg | ~8.5ms |

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
| SMS stuck accepted | worker + operator logs | Restart worker; check Kafka topics |
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
npm run full:up    # infra + migrate/seed + all Nest apps
npm run full:down
```

Host apps talk to Kafka on `localhost:9092`; containers use `kafka:29092` (dual listeners). Do not mix host Nest processes with `full` profile on the same ports (3000/3010).

## Tests

```bash
npm test
npm run test:integration   # needs live API (+ stack)
npm run test:k6            # needs https://k6.io installed + API up
# k6 run -e VUS=20 -e DURATION=30s -e PRIORITY=express scripts/k6/sms-load.js
```
