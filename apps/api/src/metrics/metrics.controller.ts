import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { pulseMetrics } from '@pulsegate/infrastructure';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return pulseMetrics.render();
  }
}
