import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { pulseMetrics } from '@pulsegate/infrastructure';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      url?: string;
    }>();
    const res = context.switchToHttp().getResponse<{ statusCode: number }>();
    const route = req.route?.path ?? req.url ?? 'unknown';
    const method = req.method;
    const end = pulseMetrics.httpDuration.startTimer({ method, route });

    return next.handle().pipe(
      tap({
        next: () => {
          const status = String(res.statusCode ?? 200);
          end({ status });
          pulseMetrics.httpRequests.inc({ method, route, status });
          if (route.includes('sms') && method === 'POST') {
            const code = res.statusCode ?? 200;
            const result =
              code === 202
                ? 'accepted'
                : code === 402
                  ? 'insufficient'
                  : code === 429
                    ? 'rate_limited'
                    : 'other';
            pulseMetrics.smsAdmit.inc({ result });
          }
        },
        error: (err: { status?: number; statusCode?: number }) => {
          const status = String(err?.status ?? err?.statusCode ?? 500);
          end({ status });
          pulseMetrics.httpRequests.inc({ method, route, status });
          if (route.includes('sms') && method === 'POST') {
            const code = Number(status);
            const result =
              code === 402
                ? 'insufficient'
                : code === 429
                  ? 'rate_limited'
                  : 'error';
            pulseMetrics.smsAdmit.inc({ result });
          }
        },
      }),
    );
  }
}
