import { createClient, ClickHouseClient } from '@clickhouse/client';
import { SmsReportQuery, SmsReportRow, SmsReportStore } from '@pulsegate/domain';

export interface ClickHouseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

/** ClickHouse DateTime64 JSONEachRow rejects ISO-8601 (`T`/`Z`). */
function toClickHouseDateTime(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid datetime: ${isoOrDate}`);
  }
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function toIsoString(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (s.includes('T')) return new Date(s.endsWith('Z') ? s : `${s}Z`).toISOString();
  return new Date(`${s.replace(' ', 'T')}Z`).toISOString();
}

export class ClickHouseSmsReportStore implements SmsReportStore {
  private readonly client: ClickHouseClient;
  private readonly database: string;

  constructor(config: ClickHouseConfig) {
    this.database = config.database;
    this.client = createClient({
      url: `http://${config.host}:${config.port}`,
      username: config.username,
      password: config.password,
      database: config.database,
    });
  }

  async upsertAccepted(row: {
    messageId: string;
    userId: string;
    to: string;
    body: string;
    priority: string;
    acceptedAt: string;
  }): Promise<void> {
    const existing = await this.findById(row.messageId);
    const acceptedAt = toClickHouseDateTime(row.acceptedAt);
    const terminal =
      existing &&
      (existing.status === 'delivered' || existing.status === 'failed');
    // If status already landed, keep terminal status and refresh payload fields.
    const status = terminal ? existing.status : 'accepted';
    const updatedAt = terminal
      ? toClickHouseDateTime(
          existing.updatedAt > row.acceptedAt
            ? existing.updatedAt
            : new Date().toISOString(),
        )
      : acceptedAt;
    await this.client.insert({
      table: 'sms_reports',
      values: [
        {
          message_id: row.messageId,
          user_id: row.userId,
          to_number: row.to || existing?.to || '',
          body: row.body || existing?.body || '',
          priority: row.priority || existing?.priority || 'normal',
          status,
          accepted_at: acceptedAt,
          updated_at: updatedAt,
          delivered_at:
            status === 'delivered'
              ? toClickHouseDateTime(existing?.deliveredAt ?? existing!.updatedAt)
              : null,
          latency_ms: terminal ? existing.latencyMs : null,
          created_at: acceptedAt,
        },
      ],
      format: 'JSONEachRow',
    });
  }

  async upsertStatus(row: {
    messageId: string;
    userId: string;
    to?: string;
    body?: string;
    priority?: string;
    acceptedAt?: string;
    status: 'delivered' | 'failed';
    at: string;
    latencyMs?: number;
  }): Promise<void> {
    // ReplacingMergeTree: newer updated_at wins; carry payload on the status event
    // so out-of-order status-before-accepted still keeps to/body/priority.
    const existing = await this.findById(row.messageId);
    const acceptedSource =
      row.acceptedAt || existing?.acceptedAt || row.at;
    const acceptedAt = toClickHouseDateTime(acceptedSource);
    const updatedAt = toClickHouseDateTime(row.at);
    await this.client.insert({
      table: 'sms_reports',
      values: [
        {
          message_id: row.messageId,
          user_id: row.userId,
          to_number: row.to || existing?.to || '',
          body: row.body || existing?.body || '',
          priority: row.priority || existing?.priority || 'normal',
          status: row.status,
          accepted_at: acceptedAt,
          updated_at: updatedAt,
          delivered_at: row.status === 'delivered' ? updatedAt : null,
          latency_ms: row.latencyMs ?? null,
          created_at: acceptedAt,
        },
      ],
      format: 'JSONEachRow',
    });
  }

  async findById(messageId: string): Promise<SmsReportRow | null> {
    const result = await this.client.query({
      query: `
        SELECT
          message_id, user_id, to_number, body, priority, status,
          accepted_at, updated_at, delivered_at, latency_ms
        FROM ${this.database}.sms_reports FINAL
        WHERE message_id = {messageId:String}
        LIMIT 1
      `,
      query_params: { messageId },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    return this.mapRow(rows[0]);
  }

  async query(q: SmsReportQuery): Promise<SmsReportRow[]> {
    const limit = Math.min(q.limit ?? 50, 500);
    const clauses = ['user_id = {userId:String}'];
    const params: Record<string, unknown> = { userId: q.userId, limit };

    if (q.from) {
      clauses.push('accepted_at >= parseDateTime64BestEffort({from:String}, 3)');
      params.from = q.from;
    }
    if (q.to) {
      clauses.push('accepted_at <= parseDateTime64BestEffort({to:String}, 3)');
      params.to = q.to;
    }
    if (q.status) {
      clauses.push('status = {status:String}');
      params.status = q.status;
    }
    if (q.priority) {
      clauses.push('priority = {priority:String}');
      params.priority = q.priority;
    }

    const result = await this.client.query({
      query: `
        SELECT
          message_id, user_id, to_number, body, priority, status,
          accepted_at, updated_at, delivered_at, latency_ms
        FROM ${this.database}.sms_reports FINAL
        WHERE ${clauses.join(' AND ')}
        ORDER BY accepted_at DESC
        LIMIT {limit:UInt32}
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): SmsReportRow {
    return {
      messageId: String(r.message_id),
      userId: String(r.user_id),
      to: String(r.to_number ?? ''),
      body: String(r.body ?? ''),
      priority: String(r.priority ?? ''),
      status: String(r.status ?? ''),
      acceptedAt: toIsoString(r.accepted_at),
      updatedAt: toIsoString(r.updated_at),
      deliveredAt: r.delivered_at == null ? null : toIsoString(r.delivered_at),
      latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
