import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('v1');

  const swagger = new DocumentBuilder()
    .setTitle('PulseGate API')
    .setDescription(
      'SMS Gateway — wallets (credit leasing) + SMS admit path.\n\n' +
        '**Demo users (seed):**\n' +
        '- `11111111-1111-1111-1111-111111111111` — demo-light\n' +
        '- `22222222-2222-2222-2222-222222222222` — demo-heavy\n\n' +
        'SMS requires header `Idempotency-Key`.',
    )
    .setVersion('0.1.0')
    .addTag('health')
    .addTag('wallets')
    .addTag('sms')
    .addTag('reports')
    .build();

  const document = SwaggerModule.createDocument(app, swagger, {
    operationIdFactory: (_controllerKey: string, methodKey: string) =>
      methodKey,
  });
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      tryItOutEnabled: true,
    },
  });

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PulseGate API http://localhost:${port}/v1`);
  // eslint-disable-next-line no-console
  console.log(`Swagger UI     http://localhost:${port}/docs`);
}

bootstrap();
