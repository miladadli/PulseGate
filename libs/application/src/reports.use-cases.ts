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

  async execute(messageId: string): Promise<SmsReportRow | null> {
    const cached = await this.credits.getMessageCache(messageId);
    if (cached) {
      return {
        messageId: cached.messageId,
        userId: cached.userId,
        to: '',
        body: '',
        priority: '',
        status: cached.status,
        acceptedAt: cached.acceptedAt,
        updatedAt: cached.acceptedAt,
        deliveredAt: null,
        latencyMs: null,
      };
    }
    return this.reports.findById(messageId);
  }
}
