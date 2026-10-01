import { Kafka, Producer, logLevel } from 'kafkajs';
import {
  SmsProduceInput,
  SmsProduceResult,
  SmsProducer,
} from '@pulsegate/domain';

const DEFINITIVE_TYPES = new Set([
  'MESSAGE_TOO_LARGE',
  'INVALID_RECORD',
  'CORRUPT_MESSAGE',
  'OFFSET_METADATA_TOO_LARGE',
  'INVALID_TOPIC_EXCEPTION',
  'RECORD_LIST_TOO_LARGE',
  'TOPIC_AUTHORIZATION_FAILED',
  'CLUSTER_AUTHORIZATION_FAILED',
]);

export class KafkaSmsProducer implements SmsProducer {
  private producer: Producer | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly clientId = 'pulsegate-api',
  ) {}

  private async ensure(): Promise<Producer> {
    if (this.producer) return this.producer;
    if (!this.connecting) {
      this.connecting = (async () => {
        const kafka = new Kafka({
          clientId: this.clientId,
          brokers: this.brokers,
          logLevel: logLevel.ERROR,
        });
        const producer = kafka.producer({
          allowAutoTopicCreation: true,
          idempotent: true,
          maxInFlightRequests: 5,
        });
        await producer.connect();
        this.producer = producer;
      })();
    }
    await this.connecting;
    return this.producer!;
  }

  async produce(input: SmsProduceInput): Promise<SmsProduceResult> {
    try {
      const producer = await this.ensure();
      await producer.send({
        topic: input.topic,
        acks: -1,
        timeout: 5000,
        messages: [
          {
            key: input.key,
            value: input.value,
            headers: input.headers,
          },
        ],
      });
      return { outcome: 'acked' };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const type = (err as { type?: string })?.type;
      if (type && DEFINITIVE_TYPES.has(type)) {
        return { outcome: 'definitive_failure', error };
      }
      return { outcome: 'ambiguous_failure', error };
    }
  }

  async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
      this.connecting = null;
    }
  }
}
