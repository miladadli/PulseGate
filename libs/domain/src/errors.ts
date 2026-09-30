export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientCreditError extends DomainError {
  constructor(message = 'Insufficient credit') {
    super(message, 'INSUFFICIENT_CREDIT');
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(userId: string) {
    super(`Wallet not found for user ${userId}`, 'WALLET_NOT_FOUND');
  }
}

export class InvalidAmountError extends DomainError {
  constructor(message = 'Amount must be a positive integer') {
    super(message, 'INVALID_AMOUNT');
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}
