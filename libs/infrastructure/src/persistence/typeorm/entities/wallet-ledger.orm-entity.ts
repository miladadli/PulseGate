import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'wallet_ledger' })
export class WalletLedgerOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'entry_type', type: 'text' })
  entryType!: string;

  @Column({ type: 'bigint' })
  amount!: string;

  @Column({ name: 'ref_id', type: 'text', nullable: true })
  refId!: string | null;

  @Column({ name: 'batch_id', type: 'text', nullable: true })
  batchId!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
