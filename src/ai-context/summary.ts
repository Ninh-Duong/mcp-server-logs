/** SUMMARY.lhub text of an export: the first file an agent reads. Each section is one function. */
import { AI_CONTEXT_TIME_ZONE } from '../config.js';
import { ExportAggregates, LOG_LEVELS, LogLevel } from '../types.js';
import { FlowRow, Pattern, SnapshotMeta, localStamp } from './model.js';

export interface SummaryInput {
  meta: SnapshotMeta;
  rows: number;
  duplicates: number;
  truncated: boolean;
  /** Caveat shown under the header table, or '' */
  note: string;
  createdAt: string;
  /** Patterns most severe first (rank = Bug #) */
  ranked: Pattern[];
  /** service → level → rows */
  counts: Map<string, Map<string, number>>;
  flowRows: FlowRow[];
  aggregates?: ExportAggregates;
}

const SEVERITY = [...LOG_LEVELS].reverse();
const md = (value: string) => value.replace(/\|/g, '\\|').replace(/`/g, "'");
const sum = (byLevel: Map<string, number>) => [...byLevel.values()].reduce((n, v) => n + v, 0);
const rank = (level: string) => (SEVERITY.indexOf(level as LogLevel) === -1 ? SEVERITY.length : SEVERITY.indexOf(level as LogLevel));

/** Most severe level first, then most frequent. */
export function rankPatterns(patterns: Iterable<Pattern>): Pattern[] {
  return [...patterns].sort((a, b) => rank(a.level) - rank(b.level) || b.count - a.count);
}

/** Sums server-side aggregates of several windows into one set for the export SUMMARY. */
export function mergeAggregates(into: ExportAggregates, add: ExportAggregates): void {
  into.noise.push(...add.noise);
  for (const t of add.templates) {
    const same = into.templates.find((x) => x.category === t.category && x.template === t.template);
    if (!same) into.templates.push({ ...t });
    else Object.assign(same, { n: same.n + t.n, firstSeen: t.firstSeen < same.firstSeen ? t.firstSeen : same.firstSeen, lastSeen: t.lastSeen > same.lastSeen ? t.lastSeen : same.lastSeen });
  }
  for (const h of add.http) {
    const same = into.http.find((x) => x.path === h.path && x.method === h.method && x.status === h.status);
    if (!same) into.http.push({ ...h });
    else Object.assign(same, { avgMs: Math.round((same.avgMs * same.n + h.avgMs * h.n) / (same.n + h.n)), n: same.n + h.n, maxMs: Math.max(same.maxMs, h.maxMs) });
  }
  into.templates.sort((a, b) => b.n - a.n);
  into.http.sort((a, b) => b.n - a.n);
}

export const noiseRows = (aggregates?: ExportAggregates) => aggregates?.noise.reduce((n, r) => n + r.n, 0) ?? 0;

export function renderSummary(s: SummaryInput): string {
  return [
    ...headerSection(s),
    ...contentsSection(s.meta, s.aggregates, s.flowRows.length),
    ...countsSection(s.counts),
    ...patternsSection(s.ranked),
    ...bugsSection(s.ranked, s.flowRows),
    ...aggregateSections(s.aggregates),
    ...filesSection(s.flowRows.length > 0),
  ].join('\n');
}

function headerSection({ meta, rows, duplicates, truncated, note, createdAt, ranked }: SummaryInput): string[] {
  return [
    `# Log export: ${meta.stream} / ${meta.service || 'all services'} / ${meta.levels?.join(', ') || 'all levels'}`,
    '',
    '| | |', '|---|---|',
    `| Source | ${meta.provider} · env ${(meta.env || 'default').toUpperCase()} · org ${md(meta.organization)} · stream ${md(meta.stream)} |`,
    `| Filter | service ${md(meta.service || 'all')} · levels ${meta.levels?.join(', ') || 'all'} |`,
    `| Time range | ${meta.from} → ${meta.to} (UTC) · ${localStamp(meta.from)} → ${localStamp(meta.to)} (${AI_CONTEXT_TIME_ZONE}) |`,
    `| Rows | ${rows} (limit ${Number.isFinite(meta.limit) ? `${meta.limit} per window` : 'none'})${truncated ? ' — **TRUNCATED: a window hit the limit, only its newest rows were fetched**' : ''} |`,
    ...(duplicates ? [`| Duplicates skipped | ${duplicates} (already in earlier exports of this stream, see INDEX.md) |`] : []),
    `| Patterns | ${ranked.length} distinct (see patterns.lhub) |`,
    `| Created | ${createdAt} |`,
    ...(meta.sql ? [`| SQL | \`${md(meta.sql)}\` |`] : []),
    ...(note ? ['', `> Note: ${note}`] : []),
  ];
}

/** Says what was downloaded row by row and what was only counted, so an agent never mistakes skipped noise for missing data. */
function contentsSection(meta: SnapshotMeta, aggregates: ExportAggregates | undefined, flows: number): string[] {
  if (!aggregates) return [];
  return [
    '',
    '## What this export contains',
    '',
    meta.includeNoise
      ? '- **Downloaded, every row** (`services/`): every log matching the filter, framework noise included (`include_noise`).'
      : `- **Downloaded, every row** (\`services/\`): every Warning/Error/Critical row, and every Information/Debug row of application loggers.\n- **Counted, not downloaded**: ${noiseRows(aggregates).toLocaleString('en-US')} framework noise rows at Information level or below (health checks, ASP.NET hosting/routing/MVC/CORS, EF Core SQL commands, HttpClient handlers, Ocelot, gRPC, MassTransit, Elsa). Totals per category are below; see docs/OPENOBSERVE_GUIDE.md "What an export keeps and what it skips".`,
    `- **Request flows** (\`rcid/\`, ${flows}): every row of each failing request, framework noise included (SQL, request in/out, outgoing HTTP).`,
    ...(meta.includeNoise ? [] : ['- Need noise rows of one request? `grep` its id in `rcid/`, or call `find_openobserve_logs_by_rcid`. All of them: export again with `include_noise: true`.']),
  ];
}

function countsSection(counts: Map<string, Map<string, number>>): string[] {
  const levelColumns = SEVERITY.filter((level) => [...counts.values()].some((byLevel) => byLevel.has(level)));
  const serviceRows = [...counts.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
  return [
    '',
    '## Counts by service and level',
    '',
    `| Service | ${levelColumns.join(' | ')} | Total |`,
    `|---|${levelColumns.map(() => '---:').join('|')}|---:|`,
    ...serviceRows.map(([service, byLevel]) => `| ${md(service)} | ${levelColumns.map((level) => byLevel.get(level) ?? 0).join(' | ')} | ${sum(byLevel)} |`),
  ];
}

function patternsSection(ranked: Pattern[]): string[] {
  const shorten = (template: string) => (template.length > 140 ? template.slice(0, 140) + '…' : template);
  return [
    '',
    '## Top patterns (most severe first)',
    '',
    '| # | Count | Level | Service | First seen | Last seen | Pattern | Example |',
    '|---:|---:|---|---|---|---|---|---|',
    ...ranked.slice(0, 20).map((p, i) => `| ${i + 1} | ${p.count} | ${p.level} | ${md(p.service)} | ${p.firstSeen} | ${p.lastSeen} | \`${md(shorten(p.template))}\` | ${p.example} |`),
  ];
}

/** One row per error pattern (= one bug) with its saved request flows. */
function bugsSection(ranked: Pattern[], flowRows: FlowRow[]): string[] {
  if (!flowRows.length) return [];
  const bugRow = (p: Pattern, i: number) => {
    const own = flowRows.filter((f) => f.pattern === i + 1);
    const list = own.slice(0, 3).map((f) => f.file + (f.rows.includes(' of ') ? ` (${f.rows})` : '')).join(', ') + (own.length > 3 ? ` +${own.length - 3} more` : '');
    return `| ${i + 1} | ${p.count} | ${md(p.service)} | \`${md(p.template.slice(0, 120))}\` | ${own.length} | ${md(own[0]?.firstFailure?.slice(0, 160) ?? '-')} | ${list || '-'} |`;
  };
  return [
    '',
    '## Bugs → request flows (start here to diagnose)',
    '',
    `One row per error pattern (= one bug). Each rcid/ file is one failing request (rcid / trace id) end to end, across all services and levels, oldest first: ${flowRows.length} flow(s) in total, all listed in manifest.lhub.`,
    '',
    '| Bug # | Count | Service | Pattern | Requests | First failing step (newest request) | Flows |',
    '|---:|---:|---|---|---:|---|---|',
    ...ranked.flatMap((p, i) => (p.level === 'Error' || p.level === 'Fatal' ? [bugRow(p, i)] : [])),
  ];
}

function aggregateSections(aggregates?: ExportAggregates): string[] {
  if (!aggregates) return [];
  return [...noiseSection(aggregates), ...templatesSection(aggregates), ...httpSection(aggregates)];
}

function noiseSection({ noise }: ExportAggregates): string[] {
  if (!noise.length) return [];
  const byCategory = new Map<string, { level: string; n: number; services: Set<string> }>();
  for (const r of noise) {
    const key = `${r.category}|${r.level}`;
    const row = byCategory.get(key) ?? { level: r.level, n: 0, services: new Set<string>() };
    row.n += r.n;
    row.services.add(r.service);
    byCategory.set(key, row);
  }
  return ['', '## Framework noise (counted, not downloaded)', '', '| Logger category | Level | Rows | Services |', '|---|---|---:|---:|',
    ...[...byCategory].sort((a, b) => b[1].n - a[1].n).slice(0, 20).map(([key, r]) => `| ${md(key.split('|')[0] || '(none)')} | ${r.level} | ${r.n} | ${r.services.size} |`)];
}

function templatesSection({ templates }: ExportAggregates): string[] {
  if (!templates.length) return [];
  return ['', 'Most frequent noise messages:', '', '| Rows | Logger category | Message | First seen | Last seen |', '|---:|---|---|---|---|',
    ...templates.slice(0, 15).map((t) => `| ${t.n} | ${md(t.category)} | \`${md(t.template.slice(0, 120))}\` | ${t.firstSeen} | ${t.lastSeen} |`)];
}

function httpSection({ http }: ExportAggregates): string[] {
  if (!http.length) return [];
  return ['', '## HTTP requests (server-side counts, noise included)', '', '| Path | Method | Status | Count | Avg ms | Max ms |', '|---|---|---|---:|---:|---:|',
    ...http.slice(0, 30).map((h) => `| ${md(h.path)} | ${h.method} | ${h.status} | ${h.n} | ${h.avgMs} | ${h.maxMs} |`)];
}

function filesSection(hasFlows: boolean): string[] {
  return [
    '',
    '## Files',
    '',
    'Every file is encrypted. Open one with `read_ai_context` (`snapshot` = this folder, `file` + `offset`/`limit`), or search all of them with its `grep`.',
    '',
    '- `services/<service>/<level>.lhub`: one JSON object per line, oldest first: `ts, level, service, message, ids, attrs` (empty fields removed).',
    ...(hasFlows ? ['- `rcid/<field>-<id>.lhub`: one failing request end to end; read the lines before the first Error to see what led to it. `manifest.lhub` → `flows` maps every flow to its bug #, services path, rows and duration.'] : []),
    '- `patterns.lhub`: every message pattern with count, first/last seen and an example `file:line`.',
    '- `manifest.lhub`: query parameters, server-side counts and the flow list.',
    '',
    '## How to dig deeper',
    '',
    '- Read the example line of a pattern (`file:line` → `read_ai_context` with that `file` and `offset`), then follow its request: `grep` the value in `ids` (rcid / correlationId / traceId).',
    '- Compare with an earlier export of the same stream (`list_ai_context_snapshots`) to tell new errors from old ones.',
    '',
  ];
}
