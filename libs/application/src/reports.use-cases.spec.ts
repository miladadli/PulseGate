import { CreditStore, SmsReportStore } from '@pulsegate/domain';
import { GetSmsByIdUseCase, GetSmsReportsUseCase } from './reports.use-cases';

function mockCredits(
  overrides: Partial<jest.Mocked<CreditStore>> = {},
): jest.Mocked<CreditStore> {
  return {
    getResidual: jest.fn(),
    grantLeaseCredit: jest.fn(),
    admitSms: jest.fn(),
    commit: jest.fn(),
    refund: jest.fn(),
    getMessageCache: jest.fn().mockResolvedValue(null),
    setResidual: jest.fn(),
    isAdmitPaused: jest.fn().mockResolvedValue(false),
    setAdmitPaused: jest.fn(),
    ...overrides,
  };
}

describe('reports use-cases', () => {
  it('GetSmsById prefers ClickHouse when present', async () => {
    const reports: jest.Mocked<SmsReportStore> = {
      upsertAccepted: jest.fn(),
      upsertStatus: jest.fn(),
      findById: jest.fn().mockResolvedValue({
        messageId: 'm2',
        userId: 'u1',
        to: '+1',
        body: 'hello',
        priority: 'express',
        status: 'delivered',
        acceptedAt: 'a',
        updatedAt: 'b',
        deliveredAt: 'c',
        latencyMs: 10,
      }),
      query: jest.fn(),
    };
    const credits = mockCredits({
      getMessageCache: jest.fn().mockResolvedValue({
        status: 'accepted',
        userId: 'u1',
        messageId: 'm2',
        acceptedAt: 'a',
        to: '+old',
        body: 'stale',
        priority: 'normal',
      }),
    });

    const uc = new GetSmsByIdUseCase(reports, credits);
    const row = await uc.execute('m2');
    expect(row?.status).toBe('delivered');
    expect(row?.body).toBe('hello');
    expect(credits.getMessageCache).not.toHaveBeenCalled();
  });

  it('GetSmsById falls back to Redis cache with payload fields', async () => {
    const reports: jest.Mocked<SmsReportStore> = {
      upsertAccepted: jest.fn(),
      upsertStatus: jest.fn(),
      findById: jest.fn().mockResolvedValue(null),
      query: jest.fn(),
    };
    const credits = mockCredits({
      getMessageCache: jest.fn().mockResolvedValue({
        status: 'accepted',
        userId: 'u1',
        messageId: 'm1',
        acceptedAt: '2026-01-01T00:00:00.000Z',
        to: '+989121111111',
        body: 'otp',
        priority: 'express',
      }),
    });

    const uc = new GetSmsByIdUseCase(reports, credits);
    const row = await uc.execute('m1');

    expect(row).toEqual({
      messageId: 'm1',
      userId: 'u1',
      to: '+989121111111',
      body: 'otp',
      priority: 'express',
      status: 'accepted',
      acceptedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deliveredAt: null,
      latencyMs: null,
    });
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
