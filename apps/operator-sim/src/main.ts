import {
  Body,
  Controller,
  HttpCode,
  Module,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

type Mode = 'express' | 'normal' | 'heavy';

@Controller()
class OperatorController {
  @Post('v1/send')
  @HttpCode(200)
  async send(
    @Body()
    body: {
      messageId: string;
      to: string;
      body: string;
      priority?: string;
      mode?: Mode;
    },
  ) {
    const mode = body.mode ?? 'normal';
    const failRate = Number(process.env.OPERATOR_FAIL_RATE ?? '0.02');
    const base = mode === 'express' ? 15 : mode === 'heavy' ? 80 : 40;
    const jitter = Math.floor(Math.random() * (mode === 'express' ? 25 : 120));
    await new Promise((r) => setTimeout(r, base + jitter));

    if (Math.random() < failRate) {
      throw new ServiceUnavailableException({
        ok: false,
        error: 'simulated_operator_failure',
        messageId: body.messageId,
      });
    }

    return {
      ok: true,
      messageId: body.messageId,
      latencyHintMs: base + jitter,
    };
  }
}

@Module({ controllers: [OperatorController] })
class OperatorModule {}

async function bootstrap() {
  const app = await NestFactory.create(OperatorModule);
  const port = Number(process.env.OPERATOR_PORT ?? 3010);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`operator-sim on http://localhost:${port}`);
}

bootstrap();
