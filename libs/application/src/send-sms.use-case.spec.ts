import {
  CreditStore,
  IngestFailedError,
  InsufficientCreditError,
  LeaseGrantService,
  PayloadMismatchError,
  SmsProducer,
  TrafficClassifier,
} from '@pulsegate/domain';
import { SendSmsUseCase } from './send-sms.use-case';
import { buildMessageId } from './sms.ids';

function mocks() {
  const credits: jest.Mocked<CreditStore> = {
    getResidual: jest.fn(),
    grantLeaseCredit: jest.fn(),
    admitSms: jest.fn(),
    commit: jest.fn(),
    refund: jest.fn(),
    getMessageCache: jest.fn(),
  };
  const leases: jest.Mocked<LeaseGrantService> = {
    grant: jest.fn(),
    refillIfNeeded: jest.fn().mockResolvedValue(0n),
  };
  const producer: jest.Mocked<SmsProducer> = {
    produce: jest.fn(),
  };
  const classifier: jest.Mocked<TrafficClassifier> = {
    classify: jest.fn().mockResolvedValue('sms.express'),
  };
  return { credits, leases, producer, classifier };
}

describe('SendSmsUseCase', () => {
  const input = {
    userId: '11111111-1111-1111-1111-111111111111',
    to: '+989121111111',
    body: 'otp',
    priority: 'express' as const,
    idempotencyKey: 'idem-1',
  };

  it('admits, produces, commits on happy path', async () => {
    const m = mocks();
    const messageId = buildMessageId(input.userId, input.idempotencyKey);
    m.credits.admitSms.mockResolvedValue({
      status: 'ok',
      messageId,
      reservationId: 'r1',
      replay: false,
      alreadyCommitted: false,
    });
    m.producer.produce.mockResolvedValue({ outcome: 'acked' });
    m.credits.commit.mockResolvedValue(undefined);

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    const res = await uc.execute(input);

    expect(m.leases.refillIfNeeded).toHaveBeenCalledWith(input.userId);
    expect(m.credits.commit).toHaveBeenCalled();
    expect(res).toEqual({
      messageId,
      status: 'accepted',
      topic: 'sms.express',
      replay: false,
    });
  });

  it('replays without produce when alreadyCommitted', async () => {
    const m = mocks();
    const messageId = buildMessageId(input.userId, input.idempotencyKey);
    m.credits.admitSms.mockResolvedValue({
      status: 'ok',
      messageId,
      reservationId: 'r1',
      replay: true,
      alreadyCommitted: true,
    });

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    const res = await uc.execute(input);

    expect(m.producer.produce).not.toHaveBeenCalled();
    expect(res.replay).toBe(true);
    expect(res.messageId).toBe(messageId);
  });

  it('throws insufficient after refill retry fails', async () => {
    const m = mocks();
    m.credits.admitSms.mockResolvedValue({ status: 'insufficient' });

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    await expect(uc.execute(input)).rejects.toBeInstanceOf(
      InsufficientCreditError,
    );
    expect(m.leases.refillIfNeeded).toHaveBeenCalledTimes(2);
    expect(m.credits.admitSms).toHaveBeenCalledTimes(2);
  });

  it('throws payload mismatch', async () => {
    const m = mocks();
    m.credits.admitSms.mockResolvedValue({ status: 'payload_mismatch' });

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    await expect(uc.execute(input)).rejects.toBeInstanceOf(PayloadMismatchError);
  });

  it('refunds on definitive kafka failure', async () => {
    const m = mocks();
    const messageId = buildMessageId(input.userId, input.idempotencyKey);
    m.credits.admitSms.mockResolvedValue({
      status: 'ok',
      messageId,
      reservationId: 'r1',
      replay: false,
      alreadyCommitted: false,
    });
    m.producer.produce.mockResolvedValue({
      outcome: 'definitive_failure',
      error: new Error('broker down'),
    });
    m.credits.refund.mockResolvedValue('refunded');

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    await expect(uc.execute(input)).rejects.toMatchObject({
      code: 'INGEST_FAILED',
      ambiguous: false,
    });
    expect(m.credits.refund).toHaveBeenCalled();
    expect(m.credits.commit).not.toHaveBeenCalled();
  });

  it('does not refund on ambiguous kafka failure', async () => {
    const m = mocks();
    const messageId = buildMessageId(input.userId, input.idempotencyKey);
    m.credits.admitSms.mockResolvedValue({
      status: 'ok',
      messageId,
      reservationId: 'r1',
      replay: false,
      alreadyCommitted: false,
    });
    m.producer.produce.mockResolvedValue({
      outcome: 'ambiguous_failure',
      error: new Error('timeout'),
    });

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    await expect(uc.execute(input)).rejects.toBeInstanceOf(IngestFailedError);
    await expect(uc.execute(input)).rejects.toMatchObject({
      ambiguous: true,
    });
    expect(m.credits.refund).not.toHaveBeenCalled();
  });

  it('routes heavy with bucketed kafka key', async () => {
    const m = mocks();
    m.classifier.classify.mockResolvedValue('sms.heavy');
    const messageId = buildMessageId(input.userId, input.idempotencyKey);
    m.credits.admitSms.mockResolvedValue({
      status: 'ok',
      messageId,
      reservationId: 'r1',
      replay: false,
      alreadyCommitted: false,
    });
    m.producer.produce.mockResolvedValue({ outcome: 'acked' });

    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
    );
    await uc.execute({ ...input, priority: 'normal' });

    expect(m.producer.produce).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'sms.heavy',
        key: expect.stringMatching(new RegExp(`^${input.userId}#\\d+$`)),
      }),
    );
  });

  it('throws RateLimitedError when limiter denies', async () => {
    const m = mocks();
    const rateLimiter = {
      tryAdmit: jest.fn().mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfterSec: 1,
      }),
    };
    const uc = new SendSmsUseCase(
      m.credits,
      m.leases,
      m.producer,
      m.classifier,
      rateLimiter,
    );
    await expect(uc.execute(input)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSec: 1,
    });
    expect(m.credits.admitSms).not.toHaveBeenCalled();
  });
});
