import Redis from 'ioredis';
import { CreditStore, WalletRepository } from '@pulsegate/domain';
import {
  DEMO_HEAVY_USER_ID,
  DEMO_LIGHT_USER_ID,
} from '../persistence/typeorm/demo-ids';

export interface ReconcilerConfig {
  redisHost: string;
  redisPort: number;
  /** How often to sweep (ms). */
  intervalMs?: number;
  /** Pending lease grants older than this are re-applied (ms). */
  pendingGrantAgeMs?: number;
  /** Log drift when |redis - leased_out| exceeds this (signal only). */
  driftThreshold?: bigint;
}

/**
 * §4.7: ZSET deadline sweep (no Kafka scan), pending grant replay, drift signal.
 */
export class ReservationReconciler {
  private redis!: Redis;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly intervalMs: number;
  private readonly pendingGrantAgeMs: number;
  private readonly driftThreshold: bigint;

  constructor(
    private readonly wallets: WalletRepository,
    private readonly credits: CreditStore,
    private readonly config: ReconcilerConfig,
  ) {
    this.intervalMs = config.intervalMs ?? 3000;
    this.pendingGrantAgeMs = config.pendingGrantAgeMs ?? 5000;
    this.driftThreshold = config.driftThreshold ?? 100n;
  }

  async start(): Promise<void> {
    this.redis = new Redis({
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: 3,
    });
    this.running = true;
    // eslint-disable-next-line no-console
    console.log(
      'ReservationReconciler started (ZSET sweep + pending grants + drift)',
    );
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('reconciler tick error', err);
      });
    }, this.intervalMs);
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.sweepDeadlines();
    await this.replayPendingGrants();
    await this.driftCheck();
  }

  private async sweepDeadlines(): Promise<void> {
    const expired = (await this.redis.zrangebyscore(
      'reservations:deadlines',
      '-inf',
      String(Date.now()),
      'LIMIT',
      0,
      100,
    )) as string[];

    for (const reservationId of expired) {
      const res = await this.redis.hgetall(`reservation:${reservationId}`);
      if (!res || !res.userId || !res.messageId) {
        await this.redis.zrem('reservations:deadlines', reservationId);
        continue;
      }

      const userId = res.userId;
      const messageId = res.messageId;
      const idemKey = res.idemKey;
      if (!idemKey) {
        await this.redis.zrem('reservations:deadlines', reservationId);
        continue;
      }

      const idemPath = `idem:${userId}:${idemKey}`;
      const state = await this.redis.hget(idemPath, 'state');

      if (state === 'DONE') {
        await this.redis.zrem('reservations:deadlines', reservationId);
        await this.redis.del(`reservation:${reservationId}`);
        continue;
      }

      if (state === 'PENDING') {
        // No refund on TTL — ambiguous produce may already be on Kafka.
        const seen = await this.redis.get(`seen:${messageId}`);
        const settledFlag = await this.redis.get(`settled:${messageId}`);
        const settledPg = await this.wallets.isMessageSettled(messageId);
        await this.credits.commit({
          userId,
          idempotencyKey: idemKey,
          reservationId,
          messageId,
        });
        // eslint-disable-next-line no-console
        console.log(
          `reconciler commit (ttl-lockup) messageId=${messageId} seen=${Boolean(seen)} settled=${Boolean(settledFlag || settledPg)}`,
        );
        continue;
      }

      await this.redis.zrem('reservations:deadlines', reservationId);
      await this.redis.del(`reservation:${reservationId}`);
    }
  }

  private async replayPendingGrants(): Promise<void> {
    const pending = await this.wallets.listPendingLeases(this.pendingGrantAgeMs);
    for (const grant of pending) {
      await this.credits.grantLeaseCredit(
        grant.grantId,
        grant.userId,
        grant.amount.amount,
      );
      await this.wallets.markLeaseApplied(grant.grantId);
      // eslint-disable-next-line no-console
      console.log(
        `reconciler re-applied grant ${grant.grantId} user=${grant.userId}`,
      );
    }
  }

  private async driftCheck(): Promise<void> {
    for (const userId of [DEMO_LIGHT_USER_ID, DEMO_HEAVY_USER_ID]) {
      const wallet = await this.wallets.findByUserId(userId);
      if (!wallet) continue;
      const residual = await this.credits.getResidual(userId);
      const leased = wallet.getLeasedOut().amount;
      if (residual > leased + this.driftThreshold) {
        // eslint-disable-next-line no-console
        console.warn(
          `reconciler drift user=${userId} residual=${residual} leased_out=${leased}`,
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.redis?.disconnect();
  }
}
