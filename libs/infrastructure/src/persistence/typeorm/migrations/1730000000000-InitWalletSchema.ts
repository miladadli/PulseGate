import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitWalletSchema1730000000000 implements MigrationInterface {
  name = 'InitWalletSchema1730000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        user_id UUID PRIMARY KEY REFERENCES users(id),
        balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
        leased_out BIGINT NOT NULL DEFAULT 0 CHECK (leased_out >= 0),
        version BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT wallets_leased_lte_balance CHECK (leased_out <= balance)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_leases (
        grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        amount BIGINT NOT NULL CHECK (amount > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_at TIMESTAMPTZ
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_wallet_leases_pending
        ON wallet_leases (status, created_at)
        WHERE status = 'pending'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        entry_type TEXT NOT NULL CHECK (entry_type IN (
          'topup', 'debit_batch', 'refund', 'reconcile', 'lease_grant', 'lease_settle'
        )),
        amount BIGINT NOT NULL,
        ref_id TEXT,
        batch_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_ref
        ON wallet_ledger (user_id, entry_type, ref_id)
        WHERE ref_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kafka_offsets (
        consumer_group TEXT NOT NULL,
        topic TEXT NOT NULL,
        partition INT NOT NULL,
        offset_value BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer_group, topic, partition)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS kafka_offsets`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_leases`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallets`);
    await queryRunner.query(`DROP TABLE IF EXISTS users`);
  }
}
