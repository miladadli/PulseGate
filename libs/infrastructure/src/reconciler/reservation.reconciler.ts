import Redis from 'ioredis';
import { CreditStore, WalletRepository } from '@pulsegate/domain';

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
    // Redis TIME is authority for expiry scores (ms approximation via local clock
    // aligned with how admit wrote Date.now() deadlines).
    const nowMs = Date.now();
    const expired = (await this.redis.zrangebyscore(
      'reservations:deadlines',
      '-inf',
      String(nowMs),
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
      const cost = BigInt(res.cost ?? '1');
      const idemKey = res.idemKey;
      if (!idemKey) {
        // Legacy reservation without idemKey — cannot safely commit/refund via Lua.
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
        const seen = await this.redis.get(`seen:${messageId}`);
        if (seen) {
          await this.credits.commit({
            userId,
            idempotencyKey: idemKey,
            reservationId,
            messageId,
          });
          // eslint-disable-next-line no-console
          console.log(`reconciler commit (seen) messageId=${messageId}`);
          continue;
        }

        const outcome = await this.credits.refund({
          userId,
          idempotencyKey: idemKey,
          reservationId,
          cost,
        });
        // eslint-disable-next-line no-console
        console.log(
          `reconciler refund (${outcome}) messageId=${messageId} reservation=${reservationId}`,
        );
        continue;
      }

      // Unknown / missing idem — drop deadline stub.
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
    // Lightweight signal: sample demo users if present; skip heavy scans.
    const demoUsers = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ];
    for (const userId of demoUsers) {
      const wallet = await this.wallets.findByUserId(userId);
      if (!wallet) continue;
      const residual = await this.credits.getResidual(userId);
      const leased = wallet.getLeasedOut().amount;
      // residual should be ≤ leased_out; large positive drift on residual vs leased
      // after settle lag is expected. Flag only extreme residual > leased + threshold.
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
