import 'reflect-metadata';
import { AppDataSource } from './data-source';
import { UserOrmEntity } from './entities/user.orm-entity';
import { WalletOrmEntity } from './entities/wallet.orm-entity';
import { DEMO_HEAVY_USER_ID, DEMO_LIGHT_USER_ID } from './demo-ids';

async function seed(): Promise<void> {
  const ds = await AppDataSource.initialize();
  try {
    const users = ds.getRepository(UserOrmEntity);
    const wallets = ds.getRepository(WalletOrmEntity);

    const seeds = [
      { id: DEMO_LIGHT_USER_ID, name: 'demo-light' },
      { id: DEMO_HEAVY_USER_ID, name: 'demo-heavy' },
    ];

    for (const s of seeds) {
      const existing = await users.findOne({ where: { id: s.id } });
      if (!existing) {
        await users.save(users.create(s));
      }
      const wallet = await wallets.findOne({ where: { userId: s.id } });
      if (!wallet) {
        await wallets.save(
          wallets.create({
            userId: s.id,
            balance: '0',
            leasedOut: '0',
            version: '0',
          }),
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log('Seed complete:', seeds.map((s) => s.name).join(', '));
  } finally {
    await ds.destroy();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
