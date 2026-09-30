export interface SmsReportRow {
  messageId: string;
  userId: string;
  to: string;
  body: string;
  priority: string;
  status: string;
  acceptedAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  latencyMs: number | null;
}

export interface SmsReportQuery {
  userId: string;
  from?: string;
  to?: string;
  status?: string;
  priority?: string;
  limit?: number;
}

export const SMS_REPORT_STORE = Symbol('SMS_REPORT_STORE');

export interface SmsReportStore {
  upsertAccepted(row: {
    messageId: string;
    userId: string;
    to: string;
    body: string;
    priority: string;
    acceptedAt: string;
  }): Promise<void>;

  upsertStatus(row: {
    messageId: string;
    userId: string;
    to?: string;
    body?: string;
    priority?: string;
    acceptedAt?: string;
    status: 'delivered' | 'failed';
    at: string;
    latencyMs?: number;
  }): Promise<void>;

  findById(messageId: string): Promise<SmsReportRow | null>;

  query(q: SmsReportQuery): Promise<SmsReportRow[]>;
}
