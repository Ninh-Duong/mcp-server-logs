/**
 * ai-context exports: AI-friendly, encrypted log exports. One folder per export, summary first, details on demand.
 *   lhub.ts           the encrypted .lhub file format
 *   model.ts          export parameters, log → line / pattern / flow id, folder names, fetch windows
 *   export-folder.ts  writing one export folder (startExport)
 *   summary.ts        SUMMARY.lhub text
 *   read.ts           listing, opening and deduplicating saved exports
 */
export { appendFrame, createLhub, readLhub, readLhubHeader, type LhubHeader } from './lhub.js';
export { fetchWindowMs, localStamp, messageTemplate, normalizeSql, queryKey, timeWindows, uncompact, type ExportResult, type SnapshotMeta } from './model.js';
export { startExport, type ExportOptions } from './export-folder.js';
export { cloneLogsToAiContext, cloneRcidToAiContext, dropExported, exportDir, findCachedLogs, findCachedQuery, findCachedRcid, listSnapshots, openSnapshot, snapshotFiles } from './read.js';
