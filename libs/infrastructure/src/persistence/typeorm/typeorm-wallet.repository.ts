import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import {
  InvalidAmountError,
  LeaseGrantRecord,
  LedgerAppend,
  Money,
  UserId,
  Wallet,
  WalletNotFoundError,
  WalletRepository,
} from '@pulsegate/domain';
import { WalletOrmEntity } from './entities/wallet.orm-entity';
import { WalletLedgerOrmEntity } from './entities/wallet-ledger.orm-entity';
import { WalletLeaseOrmEntity } from './entities/wallet-lease.orm-entity';
import { KafkaOffsetOrmEntity } from './entities/kafka-offset.orm-entity';

const LEDGER_GROUP = 'ledger';

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly dataSource: DataSource) {}

  private wallets(em?: EntityManager): Repository<WalletOrmEntity> {
    return (em ?? this.dataSource).getRepository(WalletOrmEntity);
  }

  private ledger(em?: EntityManager): Repository<WalletLedgerOrmEntity> {
    return (em ?? this.dataSource).getRepository(WalletLedgerOrmEntity);
  }

  private leases(em?: EntityManager): Repository<WalletLeaseOrmEntity> {
    return (em ?? this.dataSource).getRepository(WalletLeaseOrmEntity);
  }

  private offsets(em?: EntityManager): Repository<KafkaOffsetOrmEntity> {
    return (em ?? this.dataSource).getRepository(KafkaOffsetOrmEntity);
  }

  private toDomain(row: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      userId: row.userId,
      balance: Money.of(row.balance),
      leasedOut: Money.of(row.leasedOut),
      version: Number(row.version),
    });
  }

  async findByUserId(userId: UserId): Promise<Wallet | null> {
    const row = await this.wallets().findOne({ where: { userId } });
    return row ? this.toDomain(row) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const snap = wallet.toSnapshot();
    await this.wallets().save({
      userId: snap.userId,
      balance: snap.balance.toString(),
      leasedOut: snap.leasedOut.toString(),
      version: String(snap.version),
    });
  }

  async appendLedger(entry: LedgerAppend): Promise<void> {
    await this.ledger().save(
      this.ledger().create({
        userId: entry.userId,
        entryType: entry.entryType,
        amount: entry.amount.toString(),
        refId: entry.refId ?? null,
        batchId: entry.batchId ?? null,
        metadata: entry.metadata ?? {},
      }),
    );
  }

  async insertPendingLease(
    grant: Omit<LeaseGrantRecord, 'status'>,
  ): Promise<void> {
    await this.leases().save(
      this.leases().create({
        grantId: grant.grantId,
        userId: grant.userId,
        amount: grant.amount.toString(),
        status: 'pending',
        appliedAt: null,
      }),
    );
  }

  async markLeaseApplied(grantId: string): Promise<void> {
    await this.leases().update(
      { grantId },
      { status: 'applied', appliedAt: new Date() },
    );
  }

  async listPendingLeases(olderThanMs: number): Promise<LeaseGrantRecord[]> {
    const rows =
      olderThanMs > 0
        ? await this.leases().find({
            where: {
              status: 'pending',
              createdAt: LessThan(new Date(Date.now() - olderThanMs)),
            },
          })
        : await this.leases().find({ where: { status: 'pending' } });
    return rows.map((r) => ({
      grantId: r.grantId,
      userId: r.userId,
      amount: Money.of(r.amount),
      status: r.status,
    }));
  }

  async topUp(userId: UserId, amount: Money, refId?: string): Promise<Wallet> {
    if (amount.isZero()) {
      throw new InvalidAmountError('Top-up amount must be > 0');
    }

    return this.dataSource.transaction(async (em) => {
      const row = await this.wallets(em).findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        throw new WalletNotFoundError(userId);
      }

      const wallet = this.toDomain(row);
      wallet.applyTopUp(amount);
      const snap = wallet.toSnapshot();

      await this.wallets(em).save({
        userId: snap.userId,
        balance: snap.balance.toString(),
        leasedOut: snap.leasedOut.toString(),
        version: String(snap.version),
      });

      await this.ledger(em).save(
        this.ledger(em).create({
          userId,
          entryType: 'topup',
          amount: amount.toString(),
          refId: refId ?? null,
          batchId: null,
          metadata: {},
        }),
      );

      return wallet;
    });
  }

  async openLeaseGrant(
    userId: UserId,
    requested: Money,
    grantId: string,
  ): Promise<{ wallet: Wallet; granted: Money }> {
    if (requested.isZero()) {
      throw new InvalidAmountError('Lease request must be > 0');
    }

    return this.dataSource.transaction(async (em) => {
      const row = await this.wallets(em).findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        throw new WalletNotFoundError(userId);
      }

      const wallet = this.toDomain(row);
      const available = wallet.availableToLease();
      if (available.isZero()) {
        return { wallet, granted: Money.zero() };
      }

      const granted = wallet.grantLease(requested);
      const snap = wallet.toSnapshot();

      await this.wallets(em).save({
        userId: snap.userId,
        balance: snap.balance.toString(),
        leasedOut: snap.leasedOut.toString(),
        version: String(snap.version),
      });

      await this.leases(em).save(
        this.leases(em).create({
          grantId,
          userId,
          amount: granted.toString(),
          status: 'pending',
          appliedAt: null,
        }),
      );

      await this.ledger(em).save(
        this.ledger(em).create({
          userId,
          entryType: 'lease_grant',
          amount: granted.toString(),
          refId: grantId,
          batchId: null,
          metadata: {},
        }),
      );

      return { wallet, granted };
    });
  }

  async isMessageSettled(messageId: string): Promise<boolean> {
    const row = await this.ledger().findOne({
      where: { entryType: 'lease_settle', refId: messageId },
    });
    return !!row;
  }

  async settleAcceptedBatch(input: {
    batchId: string;
    debits: Array<{ userId: UserId; messageId: string; cost: bigint }>;
    offsets: Array<{ topic: string; partition: number; offset: string }>;
  }): Promise<{ settledMessageIds: string[]; skippedMessageIds: string[] }> {
    const settledMessageIds: string[] = [];
    const skippedMessageIds: string[] = [];

    await this.dataSource.transaction(async (em) => {
      const perUser = new Map<string, bigint>();

      for (const debit of input.debits) {
        const existing = await this.ledger(em).findOne({
          where: { entryType: 'lease_settle', refId: debit.messageId },
        });
        if (existing) {
          skippedMessageIds.push(debit.messageId);
          continue;
        }

        // Pre-settle terminal refund: skip debit (worker already credited Redis).
        const refunded = await this.ledger(em).findOne({
          where: { entryType: 'refund', refId: debit.messageId },
        });
        if (refunded) {
          skippedMessageIds.push(debit.messageId);
          continue;
        }

        await this.ledger(em).save(
          this.ledger(em).create({
            userId: debit.userId,
            entryType: 'lease_settle',
            amount: debit.cost.toString(),
            refId: debit.messageId,
            batchId: input.batchId,
            metadata: {},
          }),
        );

        perUser.set(
          debit.userId,
          (perUser.get(debit.userId) ?? 0n) + debit.cost,
        );
        settledMessageIds.push(debit.messageId);
      }

      for (const [userId, total] of perUser) {
        if (total <= 0n) continue;
        const row = await this.wallets(em).findOne({
          where: { userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row) {
          throw new WalletNotFoundError(userId);
        }
        const wallet = this.toDomain(row);
        wallet.settleConsumption(Money.of(total));
        const snap = wallet.toSnapshot();
        await this.wallets(em).save({
          userId: snap.userId,
          balance: snap.balance.toString(),
          leasedOut: snap.leasedOut.toString(),
          version: String(snap.version),
        });
        await this.ledger(em).save(
          this.ledger(em).create({
            userId,
            entryType: 'debit_batch',
            amount: total.toString(),
            refId: `${input.batchId}:${userId}`,
            batchId: input.batchId,
            metadata: { settled: settledMessageIds.length },
          }),
        );
      }

      for (const off of input.offsets) {
        await this.offsets(em).save({
          consumerGroup: LEDGER_GROUP,
          topic: off.topic,
          partition: off.partition,
          offsetValue: off.offset,
        });
      }
    });

    return { settledMessageIds, skippedMessageIds };
  }

  async applyPostSettleRefund(
    userId: UserId,
    messageId: string,
    cost: bigint,
  ): Promise<'applied' | 'already_applied' | 'not_settled'> {
    return this.dataSource.transaction(async (em) => {
      const already = await this.ledger(em).findOne({
        where: { entryType: 'refund', refId: messageId },
      });
      if (already) return 'already_applied';

      const settled = await this.ledger(em).findOne({
        where: { entryType: 'lease_settle', refId: messageId },
      });
      if (!settled) {
        // Pre-settle: record refund marker so settle skips this messageId.
        await this.ledger(em).save(
          this.ledger(em).create({
            userId,
            entryType: 'refund',
            amount: cost.toString(),
            refId: messageId,
            batchId: null,
            metadata: { phase: 'pre_settle' },
          }),
        );
        return 'not_settled';
      }

      const row = await this.wallets(em).findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        throw new WalletNotFoundError(userId);
      }
      const wallet = this.toDomain(row);
      wallet.applyPostSettleRefund(Money.of(cost));
      const snap = wallet.toSnapshot();
      await this.wallets(em).save({
        userId: snap.userId,
        balance: snap.balance.toString(),
        leasedOut: snap.leasedOut.toString(),
        version: String(snap.version),
      });
      await this.ledger(em).save(
        this.ledger(em).create({
          userId,
          entryType: 'refund',
          amount: cost.toString(),
          refId: messageId,
          batchId: null,
          metadata: { phase: 'post_settle' },
        }),
      );
      return 'applied';
    });
  }

  async listAllWallets(): Promise<Wallet[]> {
    const rows = await this.wallets().find();
    return rows.map((r) => this.toDomain(r));
  }
}
