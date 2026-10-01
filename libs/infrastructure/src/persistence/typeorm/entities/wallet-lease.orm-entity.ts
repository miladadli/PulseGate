import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'wallet_leases' })
export class WalletLeaseOrmEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'grant_id' })
  grantId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'bigint' })
  amount!: string;

  @Column({ type: 'text' })
  status!: 'pending' | 'applied';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt!: Date | null;
}
