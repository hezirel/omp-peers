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
/** A lock older than this is presumed abandoned and is broken. */
export declare const LOCK_STALE_MS = 10000;
/** Default wait for a busy lock. */
export declare const LOCK_TIMEOUT_MS = 10000;
/** Delay before retrying a torn/partial JSON read. */
export declare const JSON_RETRY_DELAY_MS = 50;
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
export declare function mkdirLock(dir: string, opts?: LockOptions): Promise<void>;
/** Release a lock held via {@link mkdirLock}. Best effort; missing is fine. */
export declare function unlockDir(dir: string): Promise<void>;
/**
 * Run `fn` while holding the mkdir-as-mutex lock at `dir`. The lock is always
 * released, even when `fn` throws. This is the ONLY sanctioned way to mutate
 * the registry files (channels.json / members.json).
 */
export declare function withRegistryLock<T>(dir: string, fn: () => Promise<T> | T, opts?: LockOptions): Promise<T>;
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
export declare function readJsonFile<T = unknown>(filePath: string, opts?: TolerantReadOptions): Promise<T | undefined>;
/**
 * Durably replace a JSON file: write a unique sidecar next to the target,
 * fsync it, copy it over the target, delete the sidecar. The sidecar never
 * coexists with a move over a live file: the target is replaced in place by
 * the copy, so any reader sees either the old or the new content.
 */
export declare function durableWriteJson(filePath: string, data: unknown, opts?: {
    pretty?: boolean;
}): Promise<void>;
/**
 * Append one JSONL record to an append-only log. A single `write()` on an
 * O_APPEND handle followed by `fsync`; records stay under the 64 KiB line cap
 * (a 32 KiB message body plus envelope overhead), so each line lands in one
 * atomic append. These files are never rewritten or moved.
 */
export declare function appendJsonl(filePath: string, record: unknown): Promise<void>;
/**
 * Number of complete lines in an append-only JSONL file. A torn tail without
 * a trailing newline (crash mid-append) is not counted; JSON bodies never
 * contain raw newlines, so every `\n` marks exactly one complete line.
 */
export declare function countJsonlLines(filePath: string): Promise<number>;
/**
 * Read every complete record of an append-only JSONL file, skipping lines that
 * fail to parse (a torn tail or a corrupt line must never break consumers).
 */
export declare function readJsonlRecords<T = unknown>(filePath: string): Promise<T[]>;
