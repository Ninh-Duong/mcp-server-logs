import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOGS_DIR } from '../config.js';

/** Organization identifiers decrypt ai-context exports, so the process log keeps only their first 4 characters. */
export const maskOrg = (identifier: string | undefined): string | undefined => identifier && `${identifier.slice(0, 4)}…`;

class ProcessLogger {
  private isCliMode: boolean = false;
  private currentDate: string = '';
  private currentFilePath: string = '';

  public setCliMode(enabled: boolean): void {
    this.isCliMode = enabled;
  }

  /** Resolves the date-partitioned log file: logs/YYYY/MM/mcp-process-YYYY-MM-DD.log */
  public getLogFilePath(isoTimestamp: string = new Date().toISOString()): string {
    const datePart = isoTimestamp.slice(0, 10);
    if (datePart === this.currentDate && this.currentFilePath) return this.currentFilePath;
    const [year, month] = datePart.split('-');
    const dir = resolve(LOGS_DIR, year!, month!);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Ignored
      }
    }
    this.currentDate = datePart;
    this.currentFilePath = resolve(dir, `mcp-process-${datePart}.log`);
    return this.currentFilePath;
  }

  private write(level: string, message: string, meta?: unknown): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
    const targetFile = this.getLogFilePath(timestamp);

    // Persist to log file
    try {
      appendFileSync(targetFile, line, 'utf8');
    } catch {
      // Avoid crash on disk write errors
    }

    // Terminal output:
    // CRITICAL: NEVER write to stdout during MCP stdio mode, as it breaks JSON-RPC!
    // The CLI shows warnings and errors only; INFO request lines stay in the log file (thousands per long export).
    if (this.isCliMode) {
      if (level !== 'info') console.log(`[${level.toUpperCase()}] ${message}${metaStr}`);
    } else {
      process.stderr.write(line);
    }
  }

  public info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }

  public warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  public error(message: string, meta?: unknown): void {
    this.write('error', message, meta);
  }

  /**
   * Retrieves the most recent log lines from the process log file
   */
  public getRecentLogs(maxLines: number = 30): string[] {
    const targetFile = this.getLogFilePath();
    if (!existsSync(targetFile)) return [];
    try {
      const content = readFileSync(targetFile, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }
}

export const logger = new ProcessLogger();
