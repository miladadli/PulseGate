import { createHash } from 'crypto';
import { Kafka, Consumer, Producer, EachMessagePayload, logLevel } from 'kafkajs';
import Redis from 'ioredis';
import { SmsAcceptedEvent } from '@pulsegate/contracts';
import { RedisCircuitBreaker } from '../redis/redis-circuit-breaker';

export type WorkerMode = 'express' | 'normal' | 'heavy';

export interface WorkerConfig {
  mode: WorkerMode;
  brokers: string[];
  operatorUrl: string;
  redisHost: string;
  redisPort: number;
  maxAttempts: number;
  /** Min gap between sends per user on heavy path (ms). */
  perTenantGapMs: number;
  /** Circuit breaker: consecutive operator failures before open. */
  cbFailureThreshold?: number;
  /** Circuit breaker open duration (ms). */
  cbOpenMs?: number;
}

export interface SmsStatusEvent {
  messageId: string;
  userId: string;
  to: string;
  body: string;
  priority: 'express' | 'normal';
  acceptedAt: string;
  cost: number;
  status: 'delivered' | 'failed';
  attempt: number;
  /** accepted_at → operator ack (Express SLO); ms */
  latencyMs?: number;
  error?: string;
  at: string;
}

const TOPIC: Record<WorkerMode, { main: string; retry: string; group: string }> =
  {
    express: {
      main: 'sms.express',
      retry: 'sms.retry.express',
      group: 'worker-express',
    },
    normal: {
      main: 'sms.normal',
      retry: 'sms.retry.normal',
      group: 'worker-normal',
    },
    heavy: {
      main: 'sms.heavy',
      retry: 'sms.retry.heavy',
      group: 'worker-heavy',
    },
  };

export class SmsDispatchWorker {
  private consumer!: Consumer;
  private producer!: Producer;
  private redis!: Redis;
  private circuit!: RedisCircuitBreaker;
  private running = false;

  constructor(private readonly config: WorkerConfig) {}

  async start(): Promise<void> {
    const kafka = new Kafka({
      clientId: `pulsegate-${this.config.mode}`,
      brokers: this.config.brokers,
      logLevel: logLevel.ERROR,
    });

    const t = TOPIC[this.config.mode];
    await this.ensureTopics(kafka, t);

    this.producer = kafka.producer({ allowAutoTopicCreation: true });
    await this.producer.connect();

    this.consumer = kafka.consumer({ groupId: t.group });
    await this.consumer.connect();
    // Earliest if no committed offset — avoids dropping admits produced during cold start.
    await this.consumer.subscribe({ topic: t.main, fromBeginning: true });
    await this.consumer.subscribe({ topic: t.retry, fromBeginning: true });

    this.redis = new Redis({
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: 3,
    });
    this.circuit = new RedisCircuitBreaker(this.redis, {
      name: `operator:${this.config.mode}`,
      failureThreshold: this.config.cbFailureThreshold ?? 5,
      openMs: this.config.cbOpenMs ?? 10_000,
    });

    this.running = true;
    // eslint-disable-next-line no-console
    console.log(
      `Worker[${this.config.mode}] consuming ${t.main} + ${t.retry} → ${this.config.operatorUrl} (CB threshold=${this.config.cbFailureThreshold ?? 5})`,
    );

    await this.consumer.run({
      eachMessage: async (payload) => this.handle(payload),
    });
  }

  private async ensureTopics(
    kafka: Kafka,
    t: { main: string; retry: string },
  ): Promise<void> {
    const desired = [
      { topic: t.main, numPartitions: this.config.mode === 'express' ? 6 : 12 },
      { topic: t.retry, numPartitions: this.config.mode === 'express' ? 6 : 12 },
      { topic: 'sms.status', numPartitions: 12 },
      { topic: 'sms.dlq', numPartitions: 3 },
      { topic: 'sms.express', numPartitions: 6 },
      { topic: 'sms.normal', numPartitions: 12 },
      { topic: 'sms.heavy', numPartitions: 12 },
      { topic: 'sms.retry.express', numPartitions: 6 },
      { topic: 'sms.retry.normal', numPartitions: 12 },
      { topic: 'sms.retry.heavy', numPartitions: 12 },
    ];
    const unique = [...new Map(desired.map((x) => [x.topic, x])).values()];

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const admin = kafka.admin();
      try {
        await admin.connect();
        const existing = new Set(await admin.listTopics());
        const missing = unique.filter((x) => !existing.has(x.topic));
        if (missing.length > 0) {
          await admin.createTopics({ waitForLeaders: true, topics: missing });
        }
        await admin.disconnect();
        return;
      } catch (err) {
        lastErr = err;
        try {
          await admin.disconnect();
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('failed to ensure kafka topics');
  }

  private async handle({ message }: EachMessagePayload): Promise<void> {
    if (!message.value) return;
    const event = JSON.parse(message.value.toString()) as SmsAcceptedEvent;
    const attempt = Number(message.headers?.attempt?.toString() ?? '1');

    const doneKey = `dispatch:done:${event.messageId}`;
    const marker = await this.redis.get(doneKey);
    if (marker === '1') return;
    // Short lock so a crash mid-send can be retried after TTL (not forever-skipped).
    const locked = await this.redis.set(doneKey, 'processing', 'PX', 120_000, 'NX');
    if (locked !== 'OK') return;

    if (this.config.mode === 'heavy') {
      await this.throttleTenant(event.userId);
    }

    if (!(await this.circuit.allow())) {
      await this.redis.del(doneKey);
      await this.retryOrDlq(event, attempt, 'circuit_open');
      return;
    }

    const started = Date.now();
    try {
      const res = await fetch(`${this.config.operatorUrl}/v1/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: event.messageId,
          to: event.to,
          body: event.body,
          priority: event.priority,
          mode: this.config.mode,
        }),
      });

      const ackAt = Date.now();
      const acceptedMs = Date.parse(event.acceptedAt);
      const latencyMs = Number.isFinite(acceptedMs)
        ? Math.max(0, ackAt - acceptedMs)
        : Math.max(0, ackAt - started);

      if (!res.ok) {
        await this.circuit.recordFailure();
        await this.redis.del(doneKey);
        await this.retryOrDlq(event, attempt, `operator_http_${res.status}`);
        return;
      }

      await this.circuit.recordSuccess();
      await this.redis.set(doneKey, '1', 'EX', 86400);
      await this.markSeen(event.messageId);
      await this.emitStatus({
        messageId: event.messageId,
        userId: event.userId,
        to: event.to,
        body: event.body,
        priority: event.priority,
        acceptedAt: event.acceptedAt,
        cost: event.cost ?? 1,
        status: 'delivered',
        attempt,
        latencyMs,
        at: new Date(ackAt).toISOString(),
      });
    } catch (err) {
      await this.circuit.recordFailure();
      await this.redis.del(doneKey);
      const msg = err instanceof Error ? err.message : String(err);
      await this.retryOrDlq(event, attempt, msg);
    }
  }

  private async throttleTenant(userId: string): Promise<void> {
    const key = `dispatch:gap:${userId}`;
    const wait = this.config.perTenantGapMs;
    for (;;) {
      const ok = await this.redis.set(key, '1', 'PX', wait, 'NX');
      if (ok === 'OK') return;
      await new Promise((r) => setTimeout(r, Math.min(wait, 50)));
    }
  }

  private async retryOrDlq(
    event: SmsAcceptedEvent,
    attempt: number,
    error: string,
  ): Promise<void> {
    const t = TOPIC[this.config.mode];
    if (attempt < this.config.maxAttempts) {
      await this.producer.send({
        topic: t.retry,
        messages: [
          {
            key: event.messageId,
            value: JSON.stringify(event),
            headers: { attempt: String(attempt + 1) },
          },
        ],
      });
      return;
    }

    await this.producer.send({
      topic: 'sms.dlq',
      messages: [
        {
          key: event.messageId,
          value: JSON.stringify({ ...event, error, attempt }),
        },
      ],
    });

    await this.emitStatus({
      messageId: event.messageId,
      userId: event.userId,
      to: event.to,
      body: event.body,
      priority: event.priority,
      acceptedAt: event.acceptedAt,
      cost: event.cost ?? 1,
      status: 'failed',
      attempt,
      error,
      at: new Date().toISOString(),
    });

    await this.terminalRefund(event);
  }

  private async terminalRefund(event: SmsAcceptedEvent): Promise<void> {
    const lock = await this.redis.set(
      `refund:${event.messageId}`,
      '1',
      'EX',
      604800,
      'NX',
    );
    if (lock !== 'OK') return;
    const settled = await this.redis.get(`settled:${event.messageId}`);
    if (settled) return;
    await this.redis.incrby(`wallet:${event.userId}:balance`, event.cost ?? 1);
  }

  private async markSeen(messageId: string): Promise<void> {
    await this.redis.set(`seen:${messageId}`, '1', 'EX', 3600);
  }

  private async emitStatus(status: SmsStatusEvent): Promise<void> {
    await this.producer.send({
      topic: 'sms.status',
      messages: [
        {
          key: status.messageId,
          value: JSON.stringify(status),
        },
      ],
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
    this.redis?.disconnect();
  }
}

export function hashPartitionHint(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 8);
}
