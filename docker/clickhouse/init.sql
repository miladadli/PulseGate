CREATE DATABASE IF NOT EXISTS pulsegate;

CREATE TABLE IF NOT EXISTS pulsegate.sms_reports
(
    message_id   String,
    user_id      String,
    to_number    String,
    body         String,
    priority     LowCardinality(String),
    status       LowCardinality(String),
    accepted_at  DateTime64(3, 'UTC'),
    updated_at   DateTime64(3, 'UTC'),
    delivered_at Nullable(DateTime64(3, 'UTC')),
    latency_ms   Nullable(UInt32),
    created_at   DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (user_id, message_id);
