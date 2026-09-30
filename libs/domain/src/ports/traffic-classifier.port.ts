import type { DispatchTopic } from './sms-producer.port';

export const TRAFFIC_CLASSIFIER = Symbol('TRAFFIC_CLASSIFIER');

export type { DispatchTopic };

export interface TrafficClassifier {
  classify(input: {
    userId: string;
    priority: 'express' | 'normal';
  }): Promise<DispatchTopic>;
}
