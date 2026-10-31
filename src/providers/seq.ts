import { config } from '../config.js';
import { LogEntry, LogProvider, LogQuery, ProviderStatus } from '../types.js';
import { LEVEL_ALIASES, normalizeLogLevel, parseTimeBound, resolveLevels } from './base.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

interface SeqEvent {
  Timestamp?: string;
  Level?: string;
  RenderedMessage?: string;
  MessageTemplate?: string;
  Properties?: Record<string, unknown> | Array<{ Name: string; Value: unknown }>;
}

export class SeqProvider implements LogProvider {
  public readonly name = 'seq';

  public getStatus(): ProviderStatus {
    const configured = Boolean(config.seq.serverUrl && config.seq.apiKey);
    const missing: string[] = [];
    if (!config.seq.serverUrl) missing.push('SEQ_SERVER_URL');
    if (!config.seq.apiKey) missing.push('SEQ_API_KEY');

    return {
      name: this.name,
      configured,
      endpoint: config.seq.serverUrl || undefined,
      missingVariables: missing.length ? missing : undefined,
      details: configured
        ? `Configured for Seq server at ${config.seq.serverUrl} (connection not verified)`
        : `Seq is unconfigured (${missing.join(', ')} missing)`,
    };
  }

  public async queryLogs(params: LogQuery): Promise<LogEntry[]> {
    const status = this.getStatus();
    if (!status.configured) throw new Error(`Seq provider is not configured: ${status.details}`);
    const url = this.eventsUrl(params);
    const requestId = randomUUID();
    const started = Date.now();
    logger.info('seq.request_started', {
      requestId, method: 'GET', endpoint: '/api/events', limit: Number(url.searchParams.get('count')),
      queryProvided: Boolean(params.query), from: url.searchParams.get('fromDateUtc') ?? undefined, to: url.searchParams.get('toDateUtc') ?? undefined,
    });
    let responseStatus: number | undefined;
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'X-Seq-ApiKey': config.seq.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      responseStatus = response.status;
      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Seq API returned HTTP ${response.status}: ${errorText}`);
      }
      const events = (await response.json()) as SeqEvent[];
      const logs = Array.isArray(events) ? events.map((event) => this.toEntry(event)) : [];
      logger.info('seq.request_succeeded', { requestId, status: responseStatus, durationMs: Date.now() - started, returned: logs.length });
      return logs;
    } catch (err) {
      logger.error('seq.request_failed', {
        requestId, status: responseStatus, durationMs: Date.now() - started, errorType: err instanceof Error ? err.name : 'UnknownError',
      });
      throw err;
    }
  }

  /** /api/events with count, filter (query and level) and time bounds. */
  private eventsUrl(params: LogQuery): URL {
    const url = new URL(`${config.seq.serverUrl}/api/events`);
    url.searchParams.set('count', String(Math.min(Math.max(params.limit || 50, 1), 500)));
    url.searchParams.set('render', 'true');
    // Push the level filter into Seq so `count` is not spent on events the service would drop.
    const levels = resolveLevels(params.level);
    const levelFilter = levels && `@Level in [${levels.flatMap((l) => LEVEL_ALIASES[l]).map((a) => `'${a}'`).join(', ')}] ci`;
    const filter = [params.query && `(${params.query})`, levelFilter].filter(Boolean).join(' and ');
    if (filter) url.searchParams.set('filter', filter);
    const fromIso = parseTimeBound(params.from);
    const toIso = parseTimeBound(params.to);
    if ((params.from && !fromIso) || (params.to && !toIso) || (fromIso && toIso && Date.parse(fromIso) >= Date.parse(toIso))) {
      throw new Error('Invalid time range');
    }
    if (fromIso) url.searchParams.set('fromDateUtc', fromIso);
    if (toIso) url.searchParams.set('toDateUtc', toIso);
    return url;
  }

  /** Properties come as an array of {Name, Value} or as an object; both become metadata. */
  private toEntry(event: SeqEvent): LogEntry {
    let metadata: Record<string, unknown> | undefined;
    if (Array.isArray(event.Properties)) {
      metadata = {};
      for (const prop of event.Properties) if (prop && prop.Name) metadata[prop.Name] = prop.Value;
    } else if (event.Properties && typeof event.Properties === 'object') {
      metadata = event.Properties;
    }
    return {
      timestamp: event.Timestamp || new Date().toISOString(),
      level: normalizeLogLevel(event.Level),
      message: event.RenderedMessage || event.MessageTemplate || 'No message provided',
      provider: this.name,
      metadata,
    };
  }
}
