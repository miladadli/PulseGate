import { CreditStore, SmsReportRow, SmsReportStore } from '@pulsegate/domain';

export class GetSmsReportsUseCase {
  constructor(private readonly reports: SmsReportStore) {}

  execute(input: {
    userId: string;
    from?: string;
    to?: string;
    status?: string;
    priority?: string;
    limit?: number;
  }): Promise<SmsReportRow[]> {
    return this.reports.query(input);
  }
}

export class GetSmsByIdUseCase {
  constructor(
    private readonly reports: SmsReportStore,
    private readonly credits: CreditStore,
  ) {}

  /**
   * Prefer ClickHouse (full row). Fall back to Redis accept-cache for early reads
   * before the projector catches up (cache now includes to/body/priority).
   */
  async execute(messageId: string): Promise<SmsReportRow | null> {
    const stored = await this.reports.findById(messageId);
    if (stored) return stored;

    const cached = await this.credits.getMessageCache(messageId);
    if (!cached) return null;

    return {
      messageId: cached.messageId,
      userId: cached.userId,
      to: cached.to,
      body: cached.body,
      priority: cached.priority,
      status: cached.status,
      acceptedAt: cached.acceptedAt,
      updatedAt: cached.acceptedAt,
      deliveredAt: null,
      latencyMs: null,
    };
  }
}
