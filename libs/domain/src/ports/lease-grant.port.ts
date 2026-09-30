export const LEASE_GRANT_SERVICE = Symbol('LEASE_GRANT_SERVICE');

export interface LeaseGrantService {
  /** Grant min(requested, available) into Redis; no-op if nothing available. */
  grant(userId: string, requested: bigint): Promise<bigint>;

  /** Single-flight refill when residual below threshold. */
  refillIfNeeded(userId: string): Promise<bigint>;
}
