import Redis from 'ioredis';
import { RateLimiter } from '@pulsegate/domain';
import { RATE_LIMIT_LUA } from './lua-scripts';

export interface RateLimitConfig {
  /** Max accepts per window for express (default 200 / 1s). */
  expressLimit: number;
  /** Max accepts per window for normal (default 50 / 1s). */
  normalLimit: number;
  windowSec: number;
}

const DEFAULTS: RateLimitConfig = {
  expressLimit: 200,
  normalLimit: 50,
  windowSec: 1,
};

/**
 * Hard ceiling before Lua credit reserve. Fairness still uses heavy path;
 * this is the emergency 429 valve from the architecture.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly config: RateLimitConfig;

  constructor(
    private readonly redis: Redis,
    config?: Partial<RateLimitConfig>,
  ) {
    this.config = { ...DEFAULTS, ...config };
  }

  async tryAdmit(input: {
    userId: string;
    priority: 'express' | 'normal';
  }): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
    const limit =
      input.priority === 'express'
        ? this.config.expressLimit
        : this.config.normalLimit;
    const window = Math.floor(Date.now() / 1000 / this.config.windowSec);
    const key = `rl:${input.userId}:${input.priority}:${window}`;

    const raw = (await this.redis.eval(
      RATE_LIMIT_LUA,
      1,
      key,
      String(limit),
      String(this.config.windowSec),
    )) as [number, number, number];

    return {
      allowed: raw[0] === 1,
      remaining: Number(raw[1]),
      retryAfterSec: Math.max(1, Number(raw[2])),
    };
  }
}
