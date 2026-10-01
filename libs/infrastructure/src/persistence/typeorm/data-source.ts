import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { typeOrmEntities } from './entities';
import { InitWalletSchema1730000000000 } from './migrations/1730000000000-InitWalletSchema';

export function buildDataSourceOptions(
  overrides: Partial<DataSourceOptions> = {},
): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER ?? 'pulsegate',
    password: process.env.POSTGRES_PASSWORD ?? 'pulsegate',
    database: process.env.POSTGRES_DB ?? 'pulsegate',
    entities: typeOrmEntities,
    migrations: [InitWalletSchema1730000000000],
    synchronize: false,
    logging: process.env.TYPEORM_LOGGING === 'true',
    ...overrides,
  } as DataSourceOptions;
}

export const AppDataSource = new DataSource(buildDataSourceOptions());
