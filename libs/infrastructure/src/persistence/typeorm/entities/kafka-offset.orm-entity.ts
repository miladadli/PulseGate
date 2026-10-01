import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'kafka_offsets' })
export class KafkaOffsetOrmEntity {
  @PrimaryColumn({ name: 'consumer_group', type: 'text' })
  consumerGroup!: string;

  @PrimaryColumn({ type: 'text' })
  topic!: string;

  @PrimaryColumn({ type: 'int' })
  partition!: number;

  @Column({ name: 'offset_value', type: 'bigint' })
  offsetValue!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
