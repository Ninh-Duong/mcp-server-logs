/**
 * The .lhub file format (v3): every file of an ai-context export.
 *   "LHUB3\n" + header JSON line (plaintext, authenticated)
 *   + frames: [u32 bytes][u64 fromMs][u64 toMs][12-byte iv][AES-256-GCM(brotli(lines))][16-byte tag]
 * Each fetch window appends one frame, so memory only ever holds one window. The key is
 * HKDF(organization identifier, the file's salt): only accounts enabled for the organization can read it back.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zlib } from 'node:zlib';

/** Plaintext header of a .lhub file: what its path already shows, never the key. */
export interface LhubHeader {
  v: 3;
  kind: 'summary' | 'patterns' | 'manifest' | 'logs' | 'flow' | 'query';
  provider: string;
  env?: string;
  organization: string;
  stream: string;
  /** logs files: their service and level */
  service?: string;
  level?: string;
  /** Export bounds (ISO) */
  from: string;
  to: string;
  /** summary only: rows downloaded by the export */
  rows?: number;
  /** summary of a cached SQL search only: its queryKey and limit (query.lhub holds the rows in result order) */
  query?: string;
  limit?: number;
  createdAt: string;
  salt: string;
}

/** What a writer sets in a header; version, salt and creation time are added by createLhub. */
export type LhubHeaderInput = Omit<LhubHeader, 'v' | 'salt' | 'createdAt'>;

/** A .lhub file open for appending frames. */
export interface LhubFile { path: string; head: Buffer; key: Buffer; frames: number; lines: number }

export const LHUB = '.lhub';
const MAGIC = 'LHUB3\n';
const FRAME_HEAD = 4 + 8 + 8 + 12;

// The HKDF info string is part of the key: changing it makes every existing export unreadable. It keeps the project's
// earlier name on purpose, like MAGIC and the .lhub extension: these are file-format constants, not branding.
const deriveKey = (orgKey: string, salt: Buffer) => Buffer.from(hkdfSync('sha256', orgKey, salt, 'mcp-log-hub/ai-context/v1', 32));

// ponytail: Brotli quality 9 (11 is ~15% smaller but far slower on large files).
const compress = (text: string) => brotliCompressSync(Buffer.from(text, 'utf8'), { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_LGWIN]: 24 } });

/** Additional data of frame `index`: binds it to its file header, position and time range. */
const frameAad = (head: Buffer, index: number, times: Buffer) => {
  const position = Buffer.alloc(4);
  position.writeUInt32BE(index);
  return Buffer.concat([head, position, times]);
};

/** Creates a .lhub file with its plaintext header; frames are appended with appendFrame. */
export function createLhub(path: string, header: LhubHeaderInput, orgKey: string): LhubFile {
  if (!orgKey) throw new Error('Organization key is required to write a snapshot');
  const salt = randomBytes(16);
  const head = Buffer.from(JSON.stringify({ v: 3, ...header, createdAt: new Date().toISOString(), salt: salt.toString('base64') }) + '\n', 'utf8');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([Buffer.from(MAGIC), head]));
  return { path, head, key: deriveKey(orgKey, salt), frames: 0, lines: 0 };
}

/** Appends one encrypted, compressed frame of `text` covering [fromMs, toMs]. */
export function appendFrame(file: LhubFile, text: string, fromMs: number, toMs: number): void {
  const times = Buffer.alloc(16);
  times.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(fromMs))), 0);
  times.writeBigUInt64BE(BigInt(Math.max(0, Math.ceil(toMs))), 8);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', file.key, iv).setAAD(frameAad(file.head, file.frames, times));
  const data = Buffer.concat([cipher.update(compress(text)), cipher.final()]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  appendFileSync(file.path, Buffer.concat([size, times, iv, data, cipher.getAuthTag()]));
  file.frames++;
}

/** Writes a whole file in one frame (SUMMARY, patterns, manifest, one flow). */
export function writeLhub(path: string, header: LhubHeaderInput, orgKey: string, text: string, fromMs: number, toMs: number): void {
  appendFrame(createLhub(path, header, orgKey), text, fromMs, toMs);
}

function splitHeader(buffer: Buffer): { head: Buffer; header: LhubHeader; bodyStart: number } {
  const end = buffer.indexOf(0x0a, MAGIC.length) + 1;
  if (buffer.subarray(0, MAGIC.length).toString('utf8') !== MAGIC || !end) throw new Error('Not an ai-context file (.lhub v3)');
  const head = buffer.subarray(MAGIC.length, end);
  return { head, header: JSON.parse(head.toString('utf8')) as LhubHeader, bodyStart: end };
}

/** Header only (no key needed): kind, source and range. */
export function readLhubHeader(path: string): LhubHeader {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    return splitHeader(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))).header;
  } finally {
    closeSync(fd);
  }
}

/** One frame's parts at `offset`, and where the next frame starts. */
function frameAt(buffer: Buffer, offset: number) {
  if (offset + FRAME_HEAD > buffer.length) throw new Error('Cannot decrypt snapshot: the file is truncated');
  const size = buffer.readUInt32BE(offset);
  const data = offset + FRAME_HEAD;
  return {
    times: buffer.subarray(offset + 4, offset + 20),
    iv: buffer.subarray(offset + 20, data),
    data: buffer.subarray(data, data + size),
    tag: buffer.subarray(data + size, data + size + 16),
    next: data + size + 16,
  };
}

/**
 * Decrypts a .lhub file. With `range`, frames entirely outside [from, to] are skipped without decrypting them.
 * A wrong key, an edited byte or reordered frames fail the GCM tag check.
 */
export function readLhub(path: string, orgKey: string, range?: { from: number; to: number }): { header: LhubHeader; text: string } {
  const buffer = readFileSync(path);
  const { head, header, bodyStart } = splitHeader(buffer);
  const key = deriveKey(orgKey, Buffer.from(header.salt, 'base64'));
  const parts: string[] = [];
  for (let offset = bodyStart, index = 0; offset < buffer.length; index++) {
    const frame = frameAt(buffer, offset);
    offset = frame.next;
    if (range && (Number(frame.times.readBigUInt64BE(8)) < range.from || Number(frame.times.readBigUInt64BE(0)) > range.to)) continue;
    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, frame.iv).setAAD(frameAad(head, index, frame.times));
      decipher.setAuthTag(frame.tag);
      plain = Buffer.concat([decipher.update(frame.data), decipher.final()]);
    } catch {
      throw new Error('Cannot decrypt snapshot: wrong organization or the file was modified');
    }
    parts.push(brotliDecompressSync(plain).toString('utf8'));
  }
  return { header, text: parts.join('') };
}
