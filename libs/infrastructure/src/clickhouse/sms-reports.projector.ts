import { Kafka, Consumer, logLevel } from 'kafkajs';
import { SmsAcceptedEvent } from '@pulsegate/contracts';
import { SmsReportStore } from '@pulsegate/domain';
import { SmsStatusEvent } from '../kafka/sms-dispatch.worker';

export interface ProjectorConfig {
  brokers: string[];
  groupId?: string;
}

export class SmsReportsProjector {
  private consumer!: Consumer;

  constructor(
    private readonly reports: SmsReportStore,
    private readonly config: ProjectorConfig,
  ) {}

  async start(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'pulsegate-projector',
      brokers: this.config.brokers,
      logLevel: logLevel.ERROR,
    });

    const admin = kafka.admin();
    await admin.connect();
    const existing = new Set(await admin.listTopics());
    const needed = [
      'sms.express',
      'sms.normal',
      'sms.heavy',
      'sms.status',
    ];
    const missing = needed
      .filter((t) => !existing.has(t))
      .map((topic) => ({
        topic,
        numPartitions: topic === 'sms.express' ? 6 : 12,
      }));
    if (missing.length) {
      await admin.createTopics({ waitForLeaders: true, topics: missing });
    }
    await admin.disconnect();

    this.consumer = kafka.consumer({
      groupId: this.config.groupId ?? 'projector',
    });
    await this.consumer.connect();
    for (const topic of needed) {
      await this.consumer.subscribe({ topic, fromBeginning: true });
    }

    // eslint-disable-next-line no-console
    console.log(
      'Projector consuming sms.express|normal|heavy + sms.status → ClickHouse',
    );

    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        const raw = message.value.toString();
        if (topic === 'sms.status') {
          const status = JSON.parse(raw) as SmsStatusEvent;
          await this.reports.upsertStatus({
            messageId: status.messageId,
            userId: status.userId,
            to: status.to,
            body: status.body,
            priority: status.priority,
            acceptedAt: status.acceptedAt,
            status: status.status,
            at: status.at,
            latencyMs: status.latencyMs,
          });
          return;
        }

        const accepted = JSON.parse(raw) as SmsAcceptedEvent;
        await this.reports.upsertAccepted({
          messageId: accepted.messageId,
          userId: accepted.userId,
          to: accepted.to,
          body: accepted.body,
          priority: accepted.priority,
          acceptedAt: accepted.acceptedAt,
        });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
