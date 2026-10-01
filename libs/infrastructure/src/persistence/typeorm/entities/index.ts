import { UserOrmEntity } from './user.orm-entity';
import { WalletOrmEntity } from './wallet.orm-entity';
import { WalletLeaseOrmEntity } from './wallet-lease.orm-entity';
import { WalletLedgerOrmEntity } from './wallet-ledger.orm-entity';
import { KafkaOffsetOrmEntity } from './kafka-offset.orm-entity';

export const typeOrmEntities = [
  UserOrmEntity,
  WalletOrmEntity,
  WalletLeaseOrmEntity,
  WalletLedgerOrmEntity,
  KafkaOffsetOrmEntity,
];

export {
  UserOrmEntity,
  WalletOrmEntity,
  WalletLeaseOrmEntity,
  WalletLedgerOrmEntity,
  KafkaOffsetOrmEntity,
};
