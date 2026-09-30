export const RATE_LIMITER = Symbol('RATE_LIMITER');

export interface RateLimiter {
  /**
   * Fixed-window admit ceiling per user (+ priority).
   * Returns allowed=false when over limit (caller should 429 before Lua reserve).
   */
  tryAdmit(input: {
    userId: string;
    priority: 'express' | 'normal';
  }): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }>;
}
