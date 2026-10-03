import { randomUUID } from 'crypto';
import { Kafka, Consumer, EachMessagePayload, logLevel } from 'kafkajs';
import Redis from 'ioredis';
import { SmsAcceptedEvent } from '@pulsegate/contracts';
import { WalletRepository } from '@pulsegate/domain';
import { SmsStatusEvent } from './sms-dispatch.worker';

const DISPATCH_TOPICS = ['sms.express', 'sms.normal', 'sms.heavy'] as const;

export interface LedgerWorkerConfig {
  brokers: string[];
  redisHost: string;
  redisPort: number;
  /** Flush settle when this many accepts buffered (default 50). */
  batchSize?: number;
  /** Flush settle at least this often (ms, default 2000). */
  flushIntervalMs?: number;
}

interface PendingDebit {
  userId: string;
  messageId: string;
  cost: bigint;
}

interface PendingOffset {
  topic: string;
  partition: number;
  offset: string;
}

/**
 * Kafka CG `ledger`: settle accepted SMS into Postgres from Kafka (not Redis).
 * Also handles terminal failed status (pre/post settle refund markers).
 */
export class LedgerSettleWorker {
  private consumer!: Consumer;
  private redis!: Redis;
  private pending: PendingDebit[] = [];
  private offsets = new Map<string, PendingOffset>();
  private flushTimer?: NodeJS.Timeout;
  private flushing = false;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly wallets: WalletRepository,
    private readonly config: LedgerWorkerConfig,
  ) {
    this.batchSize = config.batchSize ?? 50;
    this.flushIntervalMs = config.flushIntervalMs ?? 2000;
  }

  async start(): Promise<void> {
    this.redis = new Redis({
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: 3,
    });

    const kafka = new Kafka({
      clientId: 'pulsegate-ledger',
      brokers: this.config.brokers,
      logLevel: logLevel.ERROR,
    });

    const needed = [...DISPATCH_TOPICS, 'sms.status'];
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const admin = kafka.admin();
      try {
        await admin.connect();
        const existing = new Set(await admin.listTopics());
        const missing = needed
          .filter((t) => !existing.has(t))
          .map((topic) => ({
            topic,
            numPartitions: topic === 'sms.express' ? 6 : 12,
          }));
        if (missing.length) {
          await admin.createTopics({ waitForLeaders: true, topics: missing });
        }
        await admin.disconnect();
        lastErr = undefined;
        break;
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
    if (lastErr) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error('failed to ensure kafka topics');
    }

    this.consumer = kafka.consumer({ groupId: 'ledger' });
    await this.consumer.connect();
    for (const topic of needed) {
      await this.consumer.subscribe({ topic, fromBeginning: true });
    }

    this.flushTimer = setInterval(() => {
      void this.flush().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('ledger flush error', err);
      });
    }, this.flushIntervalMs);

    // eslint-disable-next-line no-console
    console.log(
      'LedgerSettleWorker CG=ledger consuming dispatch + sms.status → PG settle',
    );

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async (payload) => this.onMessage(payload),
    });
  }

  private async onMessage({
    topic,
    partition,
    message,
  }: EachMessagePayload): Promise<void> {
    if (!message.value) return;
    const raw = message.value.toString();
    const offset = message.offset;

    if (topic === 'sms.status') {
      const status = JSON.parse(raw) as SmsStatusEvent;
      await this.redis.set(`seen:${status.messageId}`, '1', 'EX', 3600);
      if (status.status === 'failed') {
        const outcome = await this.wallets.applyPostSettleRefund(
          status.userId,
          status.messageId,
          BigInt(status.cost ?? 1),
        );
        // Post-settle: restore spendable into Redis residual (PG already credited).
        if (outcome === 'applied') {
          await this.redis.incrby(
            `wallet:${status.userId}:balance`,
            status.cost ?? 1,
          );
        }
      }
      this.trackOffset(topic, partition, offset);
      return;
    }

    const accepted = JSON.parse(raw) as SmsAcceptedEvent;
    await this.redis.set(`seen:${accepted.messageId}`, '1', 'EX', 3600);
    this.pending.push({
      userId: accepted.userId,
      messageId: accepted.messageId,
      cost: BigInt(accepted.cost ?? 1),
    });
    this.trackOffset(topic, partition, offset);

    if (this.pending.length >= this.batchSize) {
      await this.flush();
    }
  }

  private trackOffset(topic: string, partition: number, offset: string): void {
    const key = `${topic}:${partition}`;
    const prev = this.offsets.get(key);
    if (!prev || BigInt(offset) > BigInt(prev.offset)) {
      this.offsets.set(key, { topic, partition, offset });
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.pending.length === 0 && this.offsets.size === 0) return;
    this.flushing = true;
    try {
      const debits = this.pending.splice(0, this.pending.length);
      const offsets = [...this.offsets.values()];
      this.offsets.clear();
      if (debits.length === 0 && offsets.length === 0) return;

      const batchId = randomUUID();
      const result = await this.wallets.settleAcceptedBatch({
        batchId,
        debits,
        offsets,
      });
      for (const id of result.settledMessageIds) {
        await this.redis.set(`settled:${id}`, '1', 'EX', 604800);
      }

      // Commit Kafka after durable PG watermark (at-least-once + idempotent settle).
      await this.consumer.commitOffsets(
        offsets.map((o) => ({
          topic: o.topic,
          partition: o.partition,
          offset: (BigInt(o.offset) + 1n).toString(),
        })),
      );

      // eslint-disable-next-line no-console
      console.log(
        `ledger settled=${result.settledMessageIds.length} skipped=${result.skippedMessageIds.length} batch=${batchId}`,
      );
    } catch (err) {
      // Put back would be complex; rely on Kafka redelivery + idempotent settle.
      // eslint-disable-next-line no-console
      console.error('ledger flush failed (will retry via Kafka)', err);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush().catch(() => undefined);
    await this.consumer?.disconnect();
    this.redis?.disconnect();
  }
}
