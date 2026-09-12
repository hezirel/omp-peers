/**
 * Windows-safe durability primitives.
 *
 * The old plugin died on EPERM races when moving a fresh file over a live one,
 * so this module NEVER moves files over live targets. Target replacement is
 * exclusively the copy-a-sidecar-over-the-target pattern (`copyFile`).
 *
 * Conventions:
 *  - Presence files: owner-only writers, no lock, sidecar + copy pattern.
 *  - Readers of any JSON file tolerate a partial read (a copy can be observed
 *    mid-flight) with one bounded retry.
 */
/**
 * Read and parse one JSON file. Missing file → undefined. A read that lands
 * mid-copy (partial content → parse error, or a transient EPERM/EBUSY) is
 * retried `retries` times with `retryDelayMs` between attempts; persistent
 * parse failure throws CorruptStateError.
 */
export declare function readJsonFile<T = unknown>(filePath: string, opts?: {
    retries?: number;
    retryDelayMs?: number;
}): Promise<T | undefined>;
/**
 * Durably replace a JSON file: write a unique sidecar next to the target,
 * fsync it, copy it over the target, delete the sidecar. The sidecar never
 * coexists with a move over a live file: the target is replaced in place by
 * the copy, so any reader sees either the old or the new content.
 */
export declare function durableWriteJson(filePath: string, data: unknown, opts?: {
    pretty?: boolean;
}): Promise<void>;
