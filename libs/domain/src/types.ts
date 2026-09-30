export type LedgerEntryType =
  | 'topup'
  | 'debit_batch'
  | 'refund'
  | 'reconcile'
  | 'lease_grant'
  | 'lease_settle';

export type LeaseStatus = 'pending' | 'applied';

export type SmsPriority = 'express' | 'normal';

export type SmsStatus =
  | 'accepted'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'dlq';
