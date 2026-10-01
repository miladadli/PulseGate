import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import {
  GetSmsByIdUseCase,
  GetSmsReportsUseCase,
  GetWalletUseCase,
  SendSmsUseCase,
  TopUpWalletUseCase,
} from '@pulsegate/application';
import {
  CREDIT_STORE,
  LEASE_GRANT_SERVICE,
  RATE_LIMITER,
  SMS_PRODUCER,
  SMS_REPORT_STORE,
  TRAFFIC_CLASSIFIER,
  WALLET_REPOSITORY,
} from '@pulsegate/domain';
import {
  buildDataSourceOptions,
  ClickHouseSmsReportStore,
  DefaultLeaseGrantService,
  KafkaOffsetOrmEntity,
  KafkaSmsProducer,
  RedisCreditStore,
  RedisRateLimiter,
  RedisTrafficClassifier,
  TypeOrmWalletRepository,
  UserOrmEntity,
  WalletLeaseOrmEntity,
  WalletLedgerOrmEntity,
  WalletOrmEntity,
  typeOrmEntities,
} from '@pulsegate/infrastructure';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { WalletsController } from './wallets/wallets.controller';
import { SmsController } from './sms/sms.controller';
import { ReportsController } from './reports/reports.controller';
import { MetricsController } from './metrics/metrics.controller';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { MetricsInterceptor } from './common/metrics.interceptor';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildDataSourceOptions({
          host: config.get<string>('POSTGRES_HOST', 'localhost'),
          port: Number(config.get<string>('POSTGRES_PORT', '5432')),
          username: config.get<string>('POSTGRES_USER', 'pulsegate'),
          password: config.get<string>('POSTGRES_PASSWORD', 'pulsegate'),
          database: config.get<string>('POSTGRES_DB', 'pulsegate'),
          entities: typeOrmEntities,
        }),
        autoLoadEntities: false,
      }),
    }),
    TypeOrmModule.forFeature([
      UserOrmEntity,
      WalletOrmEntity,
      WalletLeaseOrmEntity,
      WalletLedgerOrmEntity,
      KafkaOffsetOrmEntity,
    ]),
  ],
  controllers: [
    HealthController,
    WalletsController,
    SmsController,
    ReportsController,
    MetricsController,
  ],
  providers: [
    HealthService,
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(config.get<string>('REDIS_PORT', '6379')),
          maxRetriesPerRequest: 3,
        }),
    },
    {
      provide: WALLET_REPOSITORY,
      useFactory: (ds: DataSource) => new TypeOrmWalletRepository(ds),
      inject: [DataSource],
    },
    {
      provide: CREDIT_STORE,
      useFactory: (redis: Redis) => new RedisCreditStore(redis),
      inject: [REDIS_CLIENT],
    },
    {
      provide: SMS_REPORT_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ClickHouseSmsReportStore({
          host: config.get<string>('CLICKHOUSE_HOST', 'localhost'),
          port: Number(config.get<string>('CLICKHOUSE_PORT', '8123')),
          username: config.get<string>('CLICKHOUSE_USER', 'default'),
          password: config.get<string>('CLICKHOUSE_PASSWORD', 'pulsegate'),
          database: config.get<string>('CLICKHOUSE_DB', 'pulsegate'),
        }),
    },
    {
      provide: LEASE_GRANT_SERVICE,
      useFactory: (
        wallets: TypeOrmWalletRepository,
        credits: RedisCreditStore,
        redis: Redis,
        config: ConfigService,
      ) =>
        new DefaultLeaseGrantService(wallets, credits, redis, {
          defaultLeaseSize: BigInt(
            config.get<string>('LEASE_DEFAULT_SIZE', '1000'),
          ),
          refillThresholdRatio: Number(
            config.get<string>('LEASE_REFILL_THRESHOLD', '0.3'),
          ),
        }),
      inject: [WALLET_REPOSITORY, CREDIT_STORE, REDIS_CLIENT, ConfigService],
    },
    {
      provide: SMS_PRODUCER,
      useFactory: (config: ConfigService) => {
        const brokers = config
          .get<string>('KAFKA_BROKERS', 'localhost:9092')
          .split(',')
          .map((b) => b.trim());
        return new KafkaSmsProducer(brokers);
      },
      inject: [ConfigService],
    },
    {
      provide: TRAFFIC_CLASSIFIER,
      useFactory: (redis: Redis) => new RedisTrafficClassifier(redis),
      inject: [REDIS_CLIENT],
    },
    {
      provide: RATE_LIMITER,
      inject: [REDIS_CLIENT, ConfigService],
      useFactory: (redis: Redis, config: ConfigService) =>
        new RedisRateLimiter(redis, {
          expressLimit: Number(config.get('RATE_LIMIT_EXPRESS', '200')),
          normalLimit: Number(config.get('RATE_LIMIT_NORMAL', '50')),
          windowSec: Number(config.get('RATE_LIMIT_WINDOW_SEC', '1')),
        }),
    },
    {
      provide: TopUpWalletUseCase,
      useFactory: (
        wallets: TypeOrmWalletRepository,
        credits: RedisCreditStore,
        leases: DefaultLeaseGrantService,
      ) => new TopUpWalletUseCase(wallets, credits, leases),
      inject: [WALLET_REPOSITORY, CREDIT_STORE, LEASE_GRANT_SERVICE],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (
        wallets: TypeOrmWalletRepository,
        credits: RedisCreditStore,
      ) => new GetWalletUseCase(wallets, credits),
      inject: [WALLET_REPOSITORY, CREDIT_STORE],
    },
    {
      provide: SendSmsUseCase,
      useFactory: (
        credits: RedisCreditStore,
        leases: DefaultLeaseGrantService,
        producer: KafkaSmsProducer,
        classifier: RedisTrafficClassifier,
        rateLimiter: RedisRateLimiter,
      ) =>
        new SendSmsUseCase(
          credits,
          leases,
          producer,
          classifier,
          rateLimiter,
        ),
      inject: [
        CREDIT_STORE,
        LEASE_GRANT_SERVICE,
        SMS_PRODUCER,
        TRAFFIC_CLASSIFIER,
        RATE_LIMITER,
      ],
    },
    {
      provide: GetSmsReportsUseCase,
      useFactory: (store: ClickHouseSmsReportStore) =>
        new GetSmsReportsUseCase(store),
      inject: [SMS_REPORT_STORE],
    },
    {
      provide: GetSmsByIdUseCase,
      useFactory: (
        store: ClickHouseSmsReportStore,
        credits: RedisCreditStore,
      ) => new GetSmsByIdUseCase(store, credits),
      inject: [SMS_REPORT_STORE, CREDIT_STORE],
    },
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(
    @Inject(SMS_PRODUCER) private readonly smsProducer: KafkaSmsProducer,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(SMS_REPORT_STORE)
    private readonly reports: ClickHouseSmsReportStore,
  ) {}

  async onModuleDestroy() {
    await this.smsProducer.disconnect();
    this.redis.disconnect();
    await this.reports.close();
  }
}
