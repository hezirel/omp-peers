/**
 * Windows-safe durability primitives.
 *
 * The old plugin died on EPERM races when moving a fresh file over a live one,
 * so this module NEVER moves files over live targets. Target replacement is
 * exclusively the copy-a-sidecar-over-the-target pattern (`copyFile`), and all
 * hot-path logs are strictly append-only (they are never rewritten).
 *
 * Conventions:
 *  - Hot paths (channel logs, inboxes): one line per single `write()` with
 *    O_APPEND plus `fsync` per line. These files are never rewritten.
 *  - Registries (channels.json / members.json): every mutation happens inside
 *    the mkdir-as-mutex registry lock; writers replace the file via a unique
 *    sidecar + copyFile; the sidecar is removed afterwards; the lock dir is
 *    removed last.
 *  - Presence files: owner-only writers, no lock, same sidecar + copy pattern.
 *  - Readers of any JSON file tolerate a partial read (a copy can be observed
 *    mid-flight) with one bounded retry.
 */

import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { CorruptStateError, LockError } from '../errors.js';

/** A lock older than this is presumed abandoned and is broken. */
export const LOCK_STALE_MS = 10_000;
/** Default wait for a busy lock. */
export const LOCK_TIMEOUT_MS = 10_000;
/** Delay before retrying a torn/partial JSON read. */
export const JSON_RETRY_DELAY_MS = 50;
/** Sidecars older than this are swept after a successful write. */
const STALE_SIDECAR_MS = 60_000;
/** Upper bound on how many bytes one JSONL record may reach (line < 64 KiB). */
const JSONL_MAX_BYTES = 64 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (): number => 20 + Math.floor(Math.random() * 40);

function hasErrno(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Memoized per-process parent-directory creation. */
const ensuredParents = new Set<string>();

async function ensureParent(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (ensuredParents.has(dir)) {
    return;
  }
  await mkdir(dir, { recursive: true });
  ensuredParents.add(dir);
}

export interface LockOptions {
  /** How long to wait for the lock before throwing LockError. */
  timeoutMs?: number;
  /** Age at which an existing lock is considered abandoned. */
  staleMs?: number;
}

/**
 * Acquire an exclusive lock by creating `dir`. EEXIST means the lock is held;
 * locks older than `staleMs` (default 10s) are presumed abandoned, removed,
 * and re-created. Never blocks longer than `timeoutMs`.
 */
export async function mkdirLock(dir: string, opts: LockOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    await ensureParent(dir);
    try {
      await mkdir(dir);
      return;
    } catch (err) {
      if (!hasErrno(err, 'EEXIST')) {
        // Transient (AV scan, share violation) or real (permissions). Retry
        // until the deadline, then report the last failure.
        lastError = err;
        if (Date.now() >= deadline) {
          throw new LockError(`could not acquire lock ${dir}: ${errMessage(err)}`);
        }
        await sleep(jitter());
        continue;
      }
    }

    // EEXIST: inspect the holder. It may have vanished between mkdir and stat.
    let ageMs: number | undefined;
    try {
      ageMs = Date.now() - (await stat(dir)).mtimeMs;
    } catch (err) {
      if (hasErrno(err, 'ENOENT')) {
        continue; // holder released it mid-inspection; retry mkdir immediately
      }
      lastError = err;
    }
    if (ageMs === undefined || ageMs > staleMs) {
      try {
        await rmdir(dir);
      } catch {
        // Someone else broke it first, or re-created it; loop and retry mkdir.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockError(
        `timed out after ${timeoutMs}ms waiting for lock ${dir}` +
          (lastError !== undefined ? ` (last error: ${errMessage(lastError)})` : '')
      );
    }
    await sleep(jitter());
  }
}

/** Release a lock held via {@link mkdirLock}. Best effort; missing is fine. */
export async function unlockDir(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch {
    // Already gone (or stolen after the stale threshold) — nothing to do.
  }
}

/**
 * Run `fn` while holding the mkdir-as-mutex lock at `dir`. The lock is always
 * released, even when `fn` throws. This is the ONLY sanctioned way to mutate
 * the registry files (channels.json / members.json).
 */
export async function withRegistryLock<T>(
  dir: string,
  fn: () => Promise<T> | T,
  opts: LockOptions = {}
): Promise<T> {
  await mkdirLock(dir, opts);
  try {
    return await fn();
  } finally {
    await unlockDir(dir);
  }
}

export interface TolerantReadOptions {
  /** Extra attempts after the first (default 1) before giving up. */
  retries?: number;
  /** Delay between attempts (default 50ms). */
  retryDelayMs?: number;
}

/**
 * Read and parse one JSON file. Missing file → undefined. A read that lands
 * mid-copy (partial content → parse error, or a transient EPERM/EBUSY) is
 * retried `retries` times with `retryDelayMs` between attempts; persistent
 * parse failure throws CorruptStateError.
 */
export async function readJsonFile<T = unknown>(
  filePath: string,
  opts: TolerantReadOptions = {}
): Promise<T | undefined> {
  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? JSON_RETRY_DELAY_MS;
  let attempt = 0;
  for (;;) {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (hasErrno(err, 'ENOENT')) {
        return undefined;
      }
      if (
        (hasErrno(err, 'EPERM') || hasErrno(err, 'EBUSY') || hasErrno(err, 'EACCES')) &&
        attempt < retries
      ) {
        attempt += 1;
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      if (attempt < retries) {
        attempt += 1;
        await sleep(retryDelayMs);
        continue;
      }
      throw new CorruptStateError(`unparseable JSON in ${filePath}`);
    }
  }
}

function sidecarPathFor(target: string): string {
  const nonce = randomBytes(5).toString('hex');
  return `${target}.${process.pid}.${nonce}.tmp`;
}

/** Best-effort cleanup of our own abandoned sidecars (> 1 minute old). */
async function sweepStaleSidecars(target: string): Promise<void> {
  try {
    const dir = dirname(target);
    const prefix = `${basename(target)}.`;
    const names = await readdir(dir);
    const now = Date.now();
    await Promise.all(
      names.map(async (name) => {
        if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
          return;
        }
        const full = join(dir, name);
        try {
          if (now - (await stat(full)).mtimeMs > STALE_SIDECAR_MS) {
            await unlink(full);
          }
        } catch {
          // Already gone.
        }
      })
    );
  } catch {
    // Directory missing or unreadable — sweep is best effort.
  }
}

/**
 * Durably replace a JSON file: write a unique sidecar next to the target,
 * fsync it, copy it over the target, delete the sidecar. The sidecar never
 * coexists with a move over a live file: the target is replaced in place by
 * the copy, so any reader sees either the old or the new content.
 */
export async function durableWriteJson(
  filePath: string,
  data: unknown,
  opts: { pretty?: boolean } = {}
): Promise<void> {
  await ensureParent(filePath);
  const text = JSON.stringify(data, null, opts.pretty === false ? undefined : 2) + '\n';
  let attempt = 0;
  for (;;) {
    const sidecar = sidecarPathFor(filePath);
    try {
      const fh = await open(sidecar, 'wx', 0o600);
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await copyFile(sidecar, filePath);
      await unlink(sidecar).catch(() => undefined);
      await sweepStaleSidecars(filePath);
      return;
    } catch (err) {
      await unlink(sidecar).catch(() => undefined);
      if (
        (hasErrno(err, 'EPERM') || hasErrno(err, 'EBUSY') || hasErrno(err, 'EACCES')) &&
        attempt < 6
      ) {
        attempt += 1;
        await sleep(jitter());
        continue;
      }
      if (hasErrno(err, 'EEXIST') && attempt < 3) {
        // Sidecar name collision (astronomically unlikely) — new nonce next try.
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Append one JSONL record to an append-only log. A single `write()` on an
 * O_APPEND handle followed by `fsync`; records stay under the 64 KiB line cap
 * (a 32 KiB message body plus envelope overhead), so each line lands in one
 * atomic append. These files are never rewritten or moved.
 */
export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line, 'utf8') > JSONL_MAX_BYTES) {
    throw new Error(`refusing to append a ${Buffer.byteLength(line, 'utf8')}-byte JSONL record (cap ${JSONL_MAX_BYTES})`);
  }
  await ensureParent(filePath);
  const fh = await open(filePath, 'a');
  try {
    await fh.write(line, null, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Number of complete lines in an append-only JSONL file. A torn tail without
 * a trailing newline (crash mid-append) is not counted; JSON bodies never
 * contain raw newlines, so every `\n` marks exactly one complete line.
 */
export async function countJsonlLines(filePath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (hasErrno(err, 'ENOENT')) {
      return 0;
    }
    throw err;
  }
  let count = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 10) {
      count += 1;
    }
  }
  return count;
}

/**
 * Read every complete record of an append-only JSONL file, skipping lines that
 * fail to parse (a torn tail or a corrupt line must never break consumers).
 */
export async function readJsonlRecords<T = unknown>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (hasErrno(err, 'ENOENT')) {
      return [];
    }
    throw err;
  }
  const records: T[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw.charCodeAt(i) === 10) {
      const line = raw.slice(start, i).trim();
      if (line !== '') {
        try {
          records.push(JSON.parse(line) as T);
        } catch {
          // Corrupt/torn line — skip it.
        }
      }
      start = i + 1;
    }
  }
  return records;
}
