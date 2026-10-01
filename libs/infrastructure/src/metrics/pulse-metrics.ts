import client, { Counter, Histogram, Registry } from 'prom-client';

/**
 * Lightweight Prometheus registry (scrape via GET /v1/metrics).
 * OTel collectors can scrape Prometheus endpoints; full OTLP export is optional.
 */
export class PulseMetrics {
  readonly registry: Registry;
  readonly httpDuration: Histogram<string>;
  readonly httpRequests: Counter<string>;
  readonly smsAdmit: Counter<string>;

  constructor() {
    this.registry = new client.Registry();
    client.collectDefaultMetrics({ register: this.registry });

    this.httpDuration = new client.Histogram({
      name: 'pulsegate_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers: [this.registry],
    });

    this.httpRequests = new client.Counter({
      name: 'pulsegate_http_requests_total',
      help: 'HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.smsAdmit = new client.Counter({
      name: 'pulsegate_sms_admit_total',
      help: 'SMS admit outcomes',
      labelNames: ['result'],
      registers: [this.registry],
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

export const pulseMetrics = new PulseMetrics();
