import { openObserveProvider } from './providers/index.js';
import { dropExported, ExportResult, SnapshotMeta, startExport } from './ai-context/index.js';
import { ExportAggregates, LogEntry } from './types.js';

export interface RunExportOptions {
  meta: SnapshotMeta;
  /** Organization identifier: encrypts every file and selects the organization for flow queries */
  orgKey: string;
  /** Fetch windows, oldest first (see timeWindows / fetchWindowMs) */
  windows: Array<{ from: string; to: string }>;
  fetchWindow: (window: { from: string; to: string }, onProgress: (rows: number) => void) => Promise<{ logs: LogEntry[]; aggregates?: ExportAggregates }>;
  /** Also save the full flow of failing requests into rcid/ */
  withFlows: boolean;
  /** Drop rows already saved by an overlapping export (default true) */
  skipDuplicates?: boolean;
  baseDir?: string;
  onProgress?: (index: number, rows: number) => void;
  onWindow?: (index: number, window: { from: string; to: string }, saved: number, duplicates: number) => void;
}

/**
 * Fetches every window into one export folder (services/<service>/<level>.lhub, one frame per window), then the
 * full flow of the export's failing requests (rcid/), then writes its SUMMARY. Shared by the CLI and the MCP tool.
 */
export async function runExport(options: RunExportOptions): Promise<ExportResult> {
  const out = startExport(options.meta, { orgKey: options.orgKey, baseDir: options.baseDir });
  for (const [index, window] of options.windows.entries()) {
    const { logs, aggregates } = await options.fetchWindow(window, (rows) => options.onProgress?.(index, rows));
    const { fresh, duplicates } = options.skipDuplicates === false
      ? { fresh: logs, duplicates: 0 }
      : dropExported(logs, options.meta, options.orgKey, window, options.baseDir);
    out.addWindow(fresh, window, aggregates, duplicates);
    options.onWindow?.(index, window, fresh.length, duplicates);
  }
  if (options.withFlows) {
    // Ids carry the time of their error, so each batch of flows is searched only around its own errors.
    const { stream, from, to } = options.meta;
    out.addFlows(await openObserveProvider.fetchFlows({ organization: options.orgKey, stream, ids: out.flowIds(), from, to }));
  }
  return out.finish();
}
