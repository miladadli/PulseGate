import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'wallets' })
export class WalletOrmEntity {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** Stored as string to preserve bigint safely in JS. */
  @Column({ type: 'bigint', default: 0 })
  balance!: string;

  @Column({ name: 'leased_out', type: 'bigint', default: 0 })
  leasedOut!: string;

  @Column({ type: 'bigint', default: 0 })
  version!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
