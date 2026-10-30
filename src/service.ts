import { LogEntry, LogLevel, LogProvider, LogQuery, ProviderStatus } from './types.js';
import { normalizeLogLevel, resolveLevels } from './providers/base.js';
import { getAllProviders, getProvider, listProviders } from './providers/index.js';
import { logger, maskOrg } from './utils/logger.js';

export class LogsService {
  /**
   * Returns configuration status of all available log providers
   */
  public listProviders(): ProviderStatus[] {
    return listProviders();
  }

  /**
   * The provider a query goes to: `name`, else the default — OpenObserve when its account (the current env) is
   * configured, else Seq. Throws for an unknown name or when neither is configured.
   */
  public resolveProvider(name?: string): LogProvider {
    if (name) {
      const provider = getProvider(name);
      if (!provider) throw new Error(`Unknown provider '${name}'. Available: ${getAllProviders().map((p) => p.name).join(', ')}`);
      return provider;
    }
    const provider = ['openobserve', 'seq'].map((n) => getProvider(n)!).find((p) => p.getStatus().configured);
    if (!provider) throw new Error('No log provider is configured: set up an OpenObserve account or Seq (list_log_providers shows what is missing)');
    return provider;
  }

  /** Queries one provider (resolveProvider), then applies the level filter, newest first, cut to the limit. */
  public async queryLogs(params: LogQuery & { provider?: string }): Promise<LogEntry[]> {
    const limit = Math.min(Math.max(params.limit || 50, 1), 500);
    const provider = this.resolveProvider(params.provider);
    logger.info('log_query_started', {
      provider: provider.name, limit, queryProvided: Boolean(params.query),
      organization: maskOrg(params.organization), stream: params.stream, level: params.level,
    });
    const logs = await provider.queryLogs({ ...params, limit });
    const results = this.filterAndSort(logs, params.level, limit);
    logger.info('log_query_completed', { provider: provider.name, returned: results.length });
    return results;
  }

  private filterAndSort(logs: LogEntry[], levelFilter?: LogLevel | LogLevel[], limit: number = 50): LogEntry[] {
    const levels = resolveLevels(levelFilter);
    const filtered = levels ? logs.filter((log) => levels.includes(normalizeLogLevel(log.level))) : logs;

    // Sort descending by timestamp (newest first)
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return filtered.slice(0, limit);
  }
}

export const defaultLogsService = new LogsService();
