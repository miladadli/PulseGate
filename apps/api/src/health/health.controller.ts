import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthResponseDto } from '../dto/api.dto';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness / Postgres connectivity' })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): Promise<HealthResponseDto> {
    return this.health.check();
  }
}
