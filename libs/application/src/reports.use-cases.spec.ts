import { CreditStore, SmsReportStore } from '@pulsegate/domain';
import { GetSmsByIdUseCase, GetSmsReportsUseCase } from './reports.use-cases';

describe('reports use-cases', () => {
  it('GetSmsById prefers redis accept-cache (early GET)', async () => {
    const reports: jest.Mocked<SmsReportStore> = {
      upsertAccepted: jest.fn(),
      upsertStatus: jest.fn(),
      findById: jest.fn(),
      query: jest.fn(),
    };
    const credits: jest.Mocked<CreditStore> = {
      getResidual: jest.fn(),
      grantLeaseCredit: jest.fn(),
      admitSms: jest.fn(),
      commit: jest.fn(),
      refund: jest.fn(),
      getMessageCache: jest.fn().mockResolvedValue({
        status: 'accepted',
        userId: 'u1',
        messageId: 'm1',
        acceptedAt: '2026-01-01T00:00:00.000Z',
      }),
    };

    const uc = new GetSmsByIdUseCase(reports, credits);
    const row = await uc.execute('m1');

    expect(row?.status).toBe('accepted');
    expect(row?.messageId).toBe('m1');
    expect(reports.findById).not.toHaveBeenCalled();
  });

  it('GetSmsById falls back to ClickHouse store', async () => {
    const reports: jest.Mocked<SmsReportStore> = {
      upsertAccepted: jest.fn(),
      upsertStatus: jest.fn(),
      findById: jest.fn().mockResolvedValue({
        messageId: 'm2',
        userId: 'u1',
        to: '+1',
        body: 'x',
        priority: 'express',
        status: 'delivered',
        acceptedAt: 'a',
        updatedAt: 'b',
        deliveredAt: 'c',
        latencyMs: 10,
      }),
      query: jest.fn(),
    };
    const credits: jest.Mocked<CreditStore> = {
      getResidual: jest.fn(),
      grantLeaseCredit: jest.fn(),
      admitSms: jest.fn(),
      commit: jest.fn(),
      refund: jest.fn(),
      getMessageCache: jest.fn().mockResolvedValue(null),
    };

    const uc = new GetSmsByIdUseCase(reports, credits);
    const row = await uc.execute('m2');
    expect(row?.status).toBe('delivered');
    expect(reports.findById).toHaveBeenCalledWith('m2');
  });

  it('GetSmsReports delegates to store.query', async () => {
    const reports: jest.Mocked<SmsReportStore> = {
      upsertAccepted: jest.fn(),
      upsertStatus: jest.fn(),
      findById: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const uc = new GetSmsReportsUseCase(reports);
    await uc.execute({ userId: 'u1', limit: 10 });
    expect(reports.query).toHaveBeenCalledWith({ userId: 'u1', limit: 10 });
  });
});
