import { CreditStore, WalletRepository } from '@pulsegate/domain';

export interface RebuildReport {
  mode: 'conservative';
  users: number;
  residualsZeroed: number;
  pendingGrantsReapplied: number;
}

/**
 * §4.6 conservative Redis rebuild after crash/flush.
 *
 * Overspend bound = 0: treat all open leases as fully consumed until proven otherwise.
 * residual := 0 for every wallet, then re-apply wallet_leases status=pending.
 * Kafka replay (exact residual) is deferred; prefer lockup over overspend.
 */
export class RedisCreditRebuilder {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly credits: CreditStore,
  ) {}

  async rebuildConservative(): Promise<RebuildReport> {
    await this.credits.setAdmitPaused(true);
    try {
      const all = await this.wallets.listAllWallets();
      let zeroed = 0;
      for (const w of all) {
        await this.credits.setResidual(w.userId, 0n);
        zeroed += 1;
      }

      const pending = await this.wallets.listPendingLeases(0);
      let reapplied = 0;
      for (const g of pending) {
        await this.credits.grantLeaseCredit(
          g.grantId,
          g.userId,
          g.amount.amount,
        );
        await this.wallets.markLeaseApplied(g.grantId);
        reapplied += 1;
      }

      return {
        mode: 'conservative',
        users: all.length,
        residualsZeroed: zeroed,
        pendingGrantsReapplied: reapplied,
      };
    } finally {
      await this.credits.setAdmitPaused(false);
    }
  }
}
