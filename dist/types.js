/**
 * Shared on-disk + wire schemas for the peers extension.
 *
 * Every presence record is schema-versioned (`v: 1`) and plain
 * JSON-serializable. These interfaces are the cross-process contract:
 * every running instance reads every other instance's `<state>/peers/<pid>.json`.
 */
export {};
