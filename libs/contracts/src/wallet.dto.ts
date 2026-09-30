export interface TopUpRequestDto {
  amount: number;
}

export interface WalletBalanceDto {
  userId: string;
  balance: string;
  leasedOut: string;
  availableToLease: string;
  redisResidual: string;
  spendable: string;
}

export interface HealthDto {
  status: 'ok' | 'degraded';
  postgres: boolean;
  redis?: boolean;
  kafka?: boolean;
  clickhouse?: boolean;
}
