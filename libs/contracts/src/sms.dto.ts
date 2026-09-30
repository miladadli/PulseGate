export type SmsPriorityDto = 'express' | 'normal';

export interface SendSmsRequestDto {
  userId: string;
  to: string;
  body: string;
  priority?: SmsPriorityDto;
}

export interface SendSmsResponseDto {
  messageId: string;
  status: 'accepted';
  topic: string;
  replay: boolean;
}

export interface SmsAcceptedEvent {
  messageId: string;
  userId: string;
  to: string;
  body: string;
  priority: 'express' | 'normal';
  topic: 'sms.express' | 'sms.normal' | 'sms.heavy';
  cost: number;
  acceptedAt: string;
  reservationId: string;
}
