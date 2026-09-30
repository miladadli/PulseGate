export const SMS_PRODUCER = Symbol('SMS_PRODUCER');

export type DispatchTopic = 'sms.express' | 'sms.normal' | 'sms.heavy';

export interface SmsProduceInput {
  topic: DispatchTopic;
  key: string;
  value: string;
  headers?: Record<string, string>;
}

export type SmsProduceResult =
  | { outcome: 'acked' }
  | { outcome: 'definitive_failure'; error: Error }
  | { outcome: 'ambiguous_failure'; error: Error };

export interface SmsProducer {
  produce(input: SmsProduceInput): Promise<SmsProduceResult>;
}
