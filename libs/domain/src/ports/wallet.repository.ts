import { Money } from '../value-objects/money';
import { UserId, Wallet } from '../wallet';
import { LeaseStatus, LedgerEntryType } from '../types';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

export interface LedgerAppend {
  userId: UserId;
  entryType: LedgerEntryType;
  amount: Money;
  refId?: string;
  batchId?: string;
  metadata?: Record<string, unknown>;
}

export interface LeaseGrantRecord {
  grantId: string;
  userId: UserId;
  amount: Money;
  status: LeaseStatus;
}

export interface WalletRepository {
  findByUserId(userId: UserId): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
  appendLedger(entry: LedgerAppend): Promise<void>;
  insertPendingLease(grant: Omit<LeaseGrantRecord, 'status'>): Promise<void>;
  markLeaseApplied(grantId: string): Promise<void>;
  listPendingLeases(olderThanMs: number): Promise<LeaseGrantRecord[]>;

  /** PG TX: ledger topup + increase balance. */
  topUp(userId: UserId, amount: Money, refId?: string): Promise<Wallet>;

  /**
   * PG TX: insert pending lease + bump leased_out.
   * Returns granted amount (0 if nothing available).
   */
  openLeaseGrant(
    userId: UserId,
    requested: Money,
    grantId: string,
  ): Promise<{ wallet: Wallet; granted: Money }>;

  /**
   * PG TX: idempotent per-message settle (lease_settle ref_id=messageId) +
   * aggregate debit_batch + upsert kafka_offsets for consumer group `ledger`.
   */
  settleAcceptedBatch(input: {
    batchId: string;
    debits: Array<{ userId: UserId; messageId: string; cost: bigint }>;
    offsets: Array<{ topic: string; partition: number; offset: string }>;
  }): Promise<{ settledMessageIds: string[]; skippedMessageIds: string[] }>;

  /** Post-settle terminal refund: balance += cost; ledger refund ref_id=messageId. */
  applyPostSettleRefund(
    userId: UserId,
    messageId: string,
    cost: bigint,
  ): Promise<'applied' | 'already_applied' | 'not_settled'>;

  isMessageSettled(messageId: string): Promise<boolean>;

  /** All wallets (for Redis rebuild / ops). */
  listAllWallets(): Promise<Wallet[]>;
}
