<div dir="rtl" lang="fa">

# معماری PulseGate

**سامانهٔ دروازهٔ پیامک توزیع‌شده** — نسخهٔ قابل‌تحویل چالش ابرآروان  
**پشته:** NestJS Monorepo · PostgreSQL · Redis (Lua) · Kafka · ClickHouse  
**هدف ظرفیت:** حدود ۱۰۰ میلیون پیامک در روز · ترافیک چندمستأجری ناعادلانه · Express با P99 &lt; ۵۰۰ms تا ack اپراتور  
**ناوردای سخت:** پس از اتمام اعتبار قابل‌خرج، هیچ پیامکی پذیرفته نمی‌شود.

نسخهٔ انگلیسی (خواناتر برای GitHub + نمودارها): [ARCHITECTURE.md](./ARCHITECTURE.md)

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
  Rec["reconciler ~3s"] --> Redis
  Rec --> PG
```

---

## ۳. بسته‌بندی Monorepo

**apps = نحوهٔ اجرا · libs = معنای دامنه.**  
API و workerها دامنهٔ مشترک دارند ولی فرایند جدا برای مقیاس مستقل.

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

## ۴. خط لولهٔ Admit (ترتیب فعلی کد)

ارکستراتور: `libs/application/src/send-sms.use-case.ts`

```mermaid
flowchart TD
  A["POST /v1/sms"] --> B{"admit:paused?"}
  B -->|بله| B1["503"]
  B -->|خیر| C{"rate limit"}
  C -->|رد| C1["429"]
  C -->|اجازه| D["refillIfNeeded"]
  D --> E["Lua admit"]
  E -->|ناکافی| F1["402"]
  E -->|ok| G["classify topic"]
  G --> H["Kafka produce"]
  H -->|ack| I["commit → 202"]
  H -->|قطعی fail| K["refund → 503"]
  H -->|مبهم| L["بدون refund → 503"]
```

**اولین lease به Redis:** معمولاً روی **top-up**؛ روی SMS فقط اگر residual هنوز خالی/زیر آستانه باشد.

---

## ۵. مسیر ارسال (Sequence)

همان جزئیات کامل در نسخهٔ انگلیسی — شامل rate limit، lease، Lua، Kafka، worker، ledger، ClickHouse و تعریف `latency_ms`.

نمودار کامل: بخش ۵ در [ARCHITECTURE.md](./ARCHITECTURE.md).

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

- سقف اجاره: `balance − leased_out` → اگر ledger عقب باشد **overspend نمی‌شود** (قفل می‌شود).
- بازسازی محافظه‌کارانه: `npm run redis:rebuild`.

---

## ۷. تاپیک‌های Kafka

`sms.express` / `sms.normal` / `sms.heavy` (+ retry / status / dlq).  
Ledger و projector با **consumer group** جدا روی همان تاپیک‌های dispatch — بدون `sms.accepted` جدا.

نمودار کامل: بخش ۷ در [ARCHITECTURE.md](./ARCHITECTURE.md).

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
| worker / projector | مصرف‌کنندهٔ Kafka (رویدادمحور) |
| ledger | Kafka + flush حدود ۲ ثانیه |
| reconciler | تایمر حدود ۳ ثانیه |

---

## ۱۰. محدودیت‌ها و اجرا

- Auth/UI خارج از محدودهٔ صورت تمرین.
- Bulk API عمداً نیست؛ همان admit قابل fan-out است.
- اثبات بار: k6 محلی — نه soak تولیدی.
- متریک: `GET /v1/metrics`.

جزئیات اجرا: [README.md](../README.md) · عملیات: [RUNBOOK.md](../RUNBOOK.md)

</div>
