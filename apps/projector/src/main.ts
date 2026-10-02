import {
  ClickHouseSmsReportStore,
  SmsReportsProjector,
} from '@pulsegate/infrastructure';

async function main() {
  const reports = new ClickHouseSmsReportStore({
    host: process.env.CLICKHOUSE_HOST ?? 'localhost',
    port: Number(process.env.CLICKHOUSE_PORT ?? 8123),
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'pulsegate',
    database: process.env.CLICKHOUSE_DB ?? 'pulsegate',
  });

  const projector = new SmsReportsProjector(reports, {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim()),
  });

  const shutdown = async () => {
    await projector.stop();
    await reports.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await projector.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
