import Redis from 'ioredis';
import {
  DispatchTopic,
  TrafficClassifier,
} from '@pulsegate/domain';

/**
 * Sliding 10s window counter + hysteresis for heavy routing.
 * Express always stays on sms.express.
 */
export class RedisTrafficClassifier implements TrafficClassifier {
  constructor(
    private readonly redis: Redis,
    private readonly enterHeavyPer10s = 50,
    private readonly leaveHeavyPer10s = 20,
  ) {}

  async classify(input: {
    userId: string;
    priority: 'express' | 'normal';
  }): Promise<DispatchTopic> {
    if (input.priority === 'express') {
      return 'sms.express';
    }

    const bucket = Math.floor(Date.now() / 1000 / 10);
    const key = `ratewin:${input.userId}:${bucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, 30);
    }

    const flagKey = `heavy:${input.userId}`;
    const isHeavy = (await this.redis.get(flagKey)) === '1';

    if (!isHeavy && count >= this.enterHeavyPer10s) {
      await this.redis.set(flagKey, '1', 'EX', 60);
      return 'sms.heavy';
    }
    if (isHeavy && count <= this.leaveHeavyPer10s) {
      await this.redis.del(flagKey);
      return 'sms.normal';
    }
    return isHeavy ? 'sms.heavy' : 'sms.normal';
  }
}
