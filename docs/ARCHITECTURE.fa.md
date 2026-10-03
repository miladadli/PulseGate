<div dir="rtl" lang="fa">

# معماری PulseGate

**سامانهٔ دروازهٔ پیامک توزیع‌شده** — نسخهٔ قابل‌تحویل چالش ابرآروان  
**پشته:** NestJS Monorepo · PostgreSQL · Redis (Lua) · Kafka · ClickHouse  
**هدف ظرفیت:** حدود ۱۰۰ میلیون پیامک در روز · ترافیک چندمستأجری ناعادلانه · Express با P99 &lt; ۵۰۰ms تا ack اپراتور  
**ناوردای سخت:** پس از اتمام اعتبار قابل‌خرج، هیچ پیامکی پذیرفته نمی‌شود.

نسخهٔ انگلیسی (خواناتر روی GitHub برای ارائه): [ARCHITECTURE.md](./ARCHITECTURE.md)

> **ترتیب پیشنهاد برای ارائه:** نمودار ۲ → ۴ → ۵ → ۶ → ۷

---

## ۱. خلاصهٔ اجرایی

مسیر کلاسیک «تراکنش Postgres به‌ازای هر پیام + Outbox» برای مقیاس ۱۰۰M/روز مناسب نیست. تصمیم اصلی:

| دغدغه | مالک |
|--------|------|
| پذیرش اعتبار (hot path) | Redis Lua روی اعتبار **اجاره داده‌شده** |
| انصاف | مسیر `sms.heavy` + فاصلهٔ ارسال per-tenant + سقف اضطراری `429` |
| ingest پایدار | Kafka با `acks=all` (همان تاپیک‌های dispatch) |
| مرجع مالی (SoR) | PostgreSQL — settle دسته‌ای از شمارش Kafka + offset در یک TX |
| تاریخچه / گزارش | فقط ClickHouse |
| ارسال به اپراتور | workerهای express / normal / heavy + retry + DLQ |

---

## ۲. نمودار کلی سیستم

```mermaid
flowchart TB
  Client(["کلاینت REST"]) --> API["apps/api"]

  subgraph hot ["مسیر داغ پذیرش"]
    API -->|"rate limit → lease → Lua"| Redis[(Redis)]
    API -->|"produce acks=all"| Kafka[(Kafka)]
    API -->|commit / refund| Redis
  end

  API -->|top-up / openLeaseGrant| PG[(PostgreSQL)]
  API -->|grantLeaseCredit| Redis

  Kafka --> WX["worker-express"]
  Kafka --> WN["worker-normal"]
  Kafka --> WH["worker-heavy"]
  WX --> Op["operator-sim"]
  WN --> Op
  WH --> Op
  WX -->|sms.status| Kafka
  WN -->|sms.status| Kafka
  WH -->|sms.status| Kafka

  Kafka --> Proj["projector"]
  Proj --> CH[(ClickHouse)]
  Kafka --> Led["ledger"]
  Led -->|settleAcceptedBatch| PG

  Rec["reconciler ~3s"] <-->|"ZSET / TTL lockup"| Redis
  Rec <-->|"pending leases"| PG
```

---

## ۳. بسته‌بندی Monorepo

**apps = نحوهٔ اجرا · libs = معنای دامنه.**

```mermaid
flowchart LR
  subgraph apps ["apps/*"]
    api["api"]
    worker["worker-*"]
    ledger["ledger"]
    projector["projector"]
    reconciler["reconciler"]
  end

  subgraph libs ["libs/*"]
    domain["domain"]
    application["application"]
    infra["infrastructure"]
    contracts["contracts"]
  end

  api --> application
  worker --> infra
  ledger --> infra
  application --> domain
  infra --> domain
```

| پورت دامنه | پیاده‌سازی |
|------------|------------|
| `CreditStore` | `redis-credit.store.ts` |
| `WalletRepository` | `typeorm-wallet.repository.ts` |
| `LeaseGrantService` | `default-lease-grant.service.ts` |
| `SmsProducer` | `kafka-sms.producer.ts` |
| `TrafficClassifier` | `redis-traffic.classifier.ts` |
| `RateLimiter` | `redis-rate-limiter.ts` |
| `SmsReportStore` | `clickhouse-sms-report.store.ts` |

---

## ۴. خط لولهٔ Admit (هم‌تراز با کد)

```mermaid
flowchart TD
  A["POST /v1/sms"] --> B{"admit:paused?"}
  B -->|بله| B1["503"]
  B -->|خیر| C{"rate limit"}
  C -->|رد| C1["429"]
  C -->|اجازه| D["refillIfNeeded"]
  D --> E["Lua admit"]
  E -->|mismatch| E1["409"]
  E -->|ok| G["classify"]
  E -->|ناکافی| F["refill دوباره"]
  F --> E2["admit retry"]
  E2 -->|ok| G
  E2 -->|باز هم ناکافی| F1["402"]
  G --> H["Kafka produce"]
  H -->|ack| I["commit → 202"]
  H -->|قطعی fail| K["refund → 503"]
  H -->|مبهم| L["بدون refund → 503"]
```

**اولین lease:** معمولاً روی top-up. روی SMS اگر residual کم باشد refill می‌شود؛ اگر admit اول insufficient باشد **یک‌بار دیگر** refill + retry.

---

## ۵. مسیر ارسال (Sequence)

نمودار کامل با Postgres در مسیر lease و retry admit:

→ بخش ۵ در [ARCHITECTURE.md](./ARCHITECTURE.md)

نکته: `LeaseGrant` با **Postgres** `openLeaseGrant` می‌زند، بعد `grantLeaseCredit` به Redis — نه self-call.

---

## ۶. اجارهٔ اعتبار

```mermaid
flowchart LR
  PG["PG: balance / leased_out"] -->|grant| Redis["Redis residual"]
  Redis -->|admit DECR| Spend["مصرف"]
  Spend --> Kafka
  Kafka --> Ledger["settle"]
  Ledger -->|debit| PG
```

- سقف اجاره: `balance − leased_out` → اگر ledger عقب باشد **overspend نمی‌شود**.
- بازسازی محافظه‌کارانه: `npm run redis:rebuild`.

---

## ۷. تاپیک‌های Kafka

نمودار کامل consumer groupها: بخش ۷ در [ARCHITECTURE.md](./ARCHITECTURE.md).

خلاصه: `sms.express|normal|heavy` + retry/status/dlq — ledger و projector روی همان تاپیک‌های dispatch با CG جدا.

---

## ۸. انصاف و SLO

| سازوکار | نقش |
|---------|-----|
| classifier | tenant سنگین → `sms.heavy` |
| gap روی heavy | جلوگیری از starvation |
| rate limit قبل از Lua | سقف اضطراری `429` |

**SLO اکسپرس:** P99 از `accepted_at` تا ack اپراتور &lt; ۵۰۰ms (`latency_ms` در ClickHouse).

---

## ۹. فرایندهای پس‌زمینه

| فرایند | مدل بیدار شدن |
|--------|----------------|
| worker / projector | Kafka (رویدادمحور) |
| ledger | Kafka + flush حدود ۲ ثانیه |
| reconciler | تایمر حدود ۳ ثانیه؛ TTL روی PENDING فقط **commit/lockup** |

Kafka لوکال تک‌broker / RF=1 است؛ production باید multi-broker با RF≥3 باشد.

---

## ۱۰. محدودیت‌ها و اجرا

- Auth/UI خارج از محدودهٔ صورت تمرین.
- Bulk API عمداً نیست.
- اثبات بار: k6 محلی.
- متریک: `GET /v1/metrics`.

[README.md](../README.md) · [RUNBOOK.md](../RUNBOOK.md)

</div>
