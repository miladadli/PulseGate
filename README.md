# PulseGate

Distributed SMS Gateway (NestJS monorepo) — high-throughput admit path, credit leasing, Kafka ingest, ClickHouse reports.

## Prerequisites

- Node.js 20+
- Docker Desktop with Compose v2+

## Quick start

### 1) Infra only (recommended for local development)

```bash
cp .env.example .env
npm install
npm run infra:up
npm run db:setup          # TypeORM migrations + seed (NOT raw SQL schema)
npm run api:dev           # Nest API on http://localhost:3000/v1
```

Health: `GET http://localhost:3000/v1/health`

Wallet (step 3):

```bash
# Top-up demo-light user (seeds credit + leases 1000 into Redis)
curl -X POST http://localhost:3000/v1/wallets/11111111-1111-1111-1111-111111111111/topups \
  -H "content-type: application/json" -d "{\"amount\":5000}"

curl http://localhost:3000/v1/wallets/11111111-1111-1111-1111-111111111111
```

Send SMS (step 4) — requires `Idempotency-Key`:

```bash
curl -X POST http://localhost:3000/v1/sms \
  -H "content-type: application/json" \
  -H "Idempotency-Key: my-key-1" \
  -d "{\"userId\":\"11111111-1111-1111-1111-111111111111\",\"to\":\"+989121111111\",\"body\":\"hello\",\"priority\":\"express\"}"
```


Stop infra:

```bash
npm run infra:down
```

Reset DB volumes + re-migrate:

```bash
npm run infra:reset
```

### 2) Full stack (clone-and-run)

```bash
npm run full:up
```

Brings up infra + migrate/seed + API, operator-sim, workers, projector, ledger, reconciler.

API: http://localhost:3000/v1 · Swagger: http://localhost:3000/docs · Metrics: http://localhost:3000/v1/metrics

Stop: `npm run full:down`

### Ops helpers

```bash
npm run redis:rebuild   # §4.6 conservative Redis residual rebuild (pauses admits)
npm run test:k6         # admit load (top-up first if you need 202s)
```

## Schema ownership

| Store | How schema is created |
|-------|------------------------|
| **Postgres** | **TypeORM entities + migrations** (`libs/infrastructure`) |
| **ClickHouse** | SQL init via Compose (`docker/clickhouse/init.sql`) |
| `docker/postgres/init.sql` | Only `CREATE EXTENSION pgcrypto` |

## Layout

```
apps/api/                 # Nest HTTP API (local: npm run api:dev)
libs/
  domain/                 # Wallet, Money, ports (no Nest/TypeORM)
  application/            # use-cases (next steps)
  infrastructure/         # TypeORM entities, migrations, adapters
  contracts/              # DTOs
docker/                   # Compose + ClickHouse init
```

## Local processes

```bash
npm run infra:up
npm run api:dev          # http://localhost:3000/docs  (Swagger)
npm run operator:dev     # http://localhost:3010
npm run worker:express   # consumes sms.express + retry
npm run projector:dev    # Kafka → ClickHouse reports
# optional:
npm run worker:normal
npm run worker:heavy
```

Swagger: [http://localhost:3000/docs](http://localhost:3000/docs)

## Tests

```bash
npm test                 # unit (domain / application / infra)
npm run test:integration # live API (needs infra + api; ideally full stack)
npm run test:all
npm run test:k6          # load test (requires k6 installed + API up)
```

Ops: see [RUNBOOK.md](./RUNBOOK.md) (rate limit, circuit breaker, SLO measurement).

| Service    | Port        |
|------------|-------------|
| API        | 3000        |
| Postgres   | 5432        |
| Redis      | 6379        |
| Kafka      | 9092        |
| ClickHouse | 8123 (HTTP) |

## Design docs

- Architecture (English + diagrams): [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- معماری (فارسی، راست‌چین): [docs/ARCHITECTURE.fa.md](./docs/ARCHITECTURE.fa.md)
- Ops / SLO: [RUNBOOK.md](./RUNBOOK.md)
