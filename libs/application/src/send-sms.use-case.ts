import { SmsAcceptedEvent } from '@pulsegate/contracts';
import {
  AdmitPausedError,
  CreditStore,
  IngestFailedError,
  InsufficientCreditError,
  LeaseGrantService,
  PayloadMismatchError,
  RateLimitedError,
  RateLimiter,
  SmsProducer,
  TrafficClassifier,
} from '@pulsegate/domain';
import { buildMessageId, buildPayloadHash, heavyBucketKey } from './sms.ids';

export class SendSmsUseCase {
  constructor(
    private readonly credits: CreditStore,
    private readonly leases: LeaseGrantService,
    private readonly producer: SmsProducer,
    private readonly classifier: TrafficClassifier,
    private readonly rateLimiter?: RateLimiter,
  ) {}

  async execute(input: {
    userId: string;
    to: string;
    body: string;
    priority: 'express' | 'normal';
    idempotencyKey: string;
  }): Promise<{
    messageId: string;
    status: 'accepted';
    topic: string;
    replay: boolean;
  }> {
    if (await this.credits.isAdmitPaused()) {
      throw new AdmitPausedError();
    }

    if (this.rateLimiter) {
      const rl = await this.rateLimiter.tryAdmit({
        userId: input.userId,
        priority: input.priority,
      });
      if (!rl.allowed) {
        throw new RateLimitedError(
          `Admit rate limit exceeded for ${input.priority}`,
          rl.retryAfterSec,
        );
      }
    }

    await this.leases.refillIfNeeded(input.userId);

    const messageId = buildMessageId(input.userId, input.idempotencyKey);
    const payloadHash = buildPayloadHash({
      to: input.to,
      body: input.body,
      priority: input.priority,
    });

    const admit = await this.credits.admitSms({
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      messageId,
      payloadHash,
      cost: 1n,
      reservationTtlSec: 60,
    });

    if (admit.status === 'insufficient') {
      await this.leases.refillIfNeeded(input.userId);
      const retry = await this.credits.admitSms({
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        messageId,
        payloadHash,
        cost: 1n,
        reservationTtlSec: 60,
      });
      if (retry.status === 'insufficient') {
        throw new InsufficientCreditError();
      }
      if (retry.status === 'payload_mismatch') {
        throw new PayloadMismatchError();
      }
      return this.afterAdmit(input, retry);
    }

    if (admit.status === 'payload_mismatch') {
      throw new PayloadMismatchError();
    }

    return this.afterAdmit(input, admit);
  }

  private async afterAdmit(
    input: {
      userId: string;
      to: string;
      body: string;
      priority: 'express' | 'normal';
      idempotencyKey: string;
    },
    admit: {
      status: 'ok';
      messageId: string;
      reservationId: string;
      replay: boolean;
      alreadyCommitted: boolean;
    },
  ) {
    const topic = await this.classifier.classify({
      userId: input.userId,
      priority: input.priority,
    });

    if (admit.alreadyCommitted) {
      return {
        messageId: admit.messageId,
        status: 'accepted' as const,
        topic,
        replay: true,
      };
    }

    const event: SmsAcceptedEvent = {
      messageId: admit.messageId,
      userId: input.userId,
      to: input.to,
      body: input.body,
      priority: input.priority,
      topic,
      cost: 1,
      acceptedAt: new Date().toISOString(),
      reservationId: admit.reservationId,
    };

    const key =
      topic === 'sms.heavy'
        ? heavyBucketKey(input.userId, admit.messageId)
        : admit.messageId;

    const produce = await this.producer.produce({
      topic,
      key,
      value: JSON.stringify(event),
      headers: {
        messageId: admit.messageId,
        userId: input.userId,
      },
    });

    if (produce.outcome === 'acked') {
      await this.credits.commit({
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        reservationId: admit.reservationId,
        messageId: admit.messageId,
        to: input.to,
        body: input.body,
        priority: input.priority,
        acceptedAt: event.acceptedAt,
      });
      return {
        messageId: admit.messageId,
        status: 'accepted' as const,
        topic,
        replay: admit.replay,
      };
    }

    if (produce.outcome === 'definitive_failure') {
      await this.credits.refund({
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        reservationId: admit.reservationId,
        cost: 1n,
      });
      throw new IngestFailedError(
        `Kafka definitive failure: ${produce.error.message}`,
        false,
      );
    }

    throw new IngestFailedError(
      `Kafka ambiguous failure: ${produce.error.message}`,
      true,
    );
  }
}
