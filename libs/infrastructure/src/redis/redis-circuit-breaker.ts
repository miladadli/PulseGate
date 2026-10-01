import Redis from 'ioredis';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening (default 5). */
  failureThreshold: number;
  /** How long to stay open (ms, default 10000). */
  openMs: number;
  /** Redis key prefix (includes worker mode). */
  name: string;
}

/**
 * Redis-backed circuit breaker shared across worker replicas.
 * closed → failures accumulate
 * open → fail-fast until TTL
 * half_open → single probe allowed; success closes, failure re-opens
 */
export class RedisCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly base: string;

  constructor(
    private readonly redis: Redis,
    config: CircuitBreakerConfig,
  ) {
    this.failureThreshold = config.failureThreshold;
    this.openMs = config.openMs;
    this.base = `cb:${config.name}`;
  }

  async allow(): Promise<boolean> {
    const state = await this.redis.get(`${this.base}:state`);
    if (state !== 'open') return true;

    // Open window expired → half-open probe
    const openUntil = await this.redis.get(`${this.base}:open_until`);
    if (openUntil && Date.now() < Number(openUntil)) {
      return false;
    }

    const probe = await this.redis.set(
      `${this.base}:probe`,
      '1',
      'PX',
      this.openMs,
      'NX',
    );
    if (probe !== 'OK') return false;

    await this.redis.set(`${this.base}:state`, 'half_open', 'PX', this.openMs);
    return true;
  }

  async recordSuccess(): Promise<void> {
    await this.redis
      .multi()
      .del(`${this.base}:failures`)
      .del(`${this.base}:open_until`)
      .del(`${this.base}:probe`)
      .set(`${this.base}:state`, 'closed')
      .exec();
  }

  async recordFailure(): Promise<CircuitState> {
    const failures = await this.redis.incr(`${this.base}:failures`);
    if (failures === 1) {
      await this.redis.expire(`${this.base}:failures`, 60);
    }

    if (failures < this.failureThreshold) {
      return 'closed';
    }

    const until = Date.now() + this.openMs;
    await this.redis
      .multi()
      .set(`${this.base}:state`, 'open', 'PX', this.openMs)
      .set(`${this.base}:open_until`, String(until), 'PX', this.openMs)
      .del(`${this.base}:probe`)
      .exec();
    return 'open';
  }
}
