import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthDto } from '@pulsegate/contracts';

@Injectable()
export class HealthService {
  constructor(private readonly dataSource: DataSource) {}

  async check(): Promise<HealthDto> {
    let postgres = false;
    try {
      await this.dataSource.query('SELECT 1');
      postgres = true;
    } catch {
      postgres = false;
    }

    return {
      status: postgres ? 'ok' : 'degraded',
      postgres,
    };
  }
}
