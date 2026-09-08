/**
 * Shared on-disk + wire schemas for the peers extension.
 *
 * Every presence record is schema-versioned (`v: 1`) and plain
 * JSON-serializable. These interfaces are the cross-process contract:
 * every running instance reads every other instance's `<state>/peers/<pid>.json`.
 */

/** Which harness a peer runs under (drives roster wording + tool hints). */
export type HarnessKind = 'omp' | 'pi';

/**
 * `<state>/peers/<pid>.json` — single-writer, owner-only presence record.
 * Written on a 15s beat; live while `now - beatAt <= 45s` and the pid answers
 * `process.kill(pid, 0)`.
 */
export interface PeerRecord {
  v: 1;
  pid: number;
  name: string;
  cwd: string;
  project: string;
  harness: HarnessKind;
  /** Owning session id (empty string when the host exposes none). */
  sessionId: string;
  /** Model id (empty string when the host exposes none). */
  model: string;
  /**
   * Socket address to reach this peer: a named-pipe path
   * (`\\.\pipe\peers-<pid>`) on Windows, a unix-socket path
   * (`<state>/peers/<pid>.sock`) elsewhere.
   */
  socket: string;
  /** `Date.now()` at process start — decides cross-process name collisions. */
  startedAt: number;
  /** `Date.now()` at the last beat — drives TTL reap + beat age. */
  beatAt: number;
  /** True when the owner's agent loop is mid-turn. */
  busy: boolean;
}

/** Frame exchanged over a peer socket, one JSON object per line. */
export type PeerFrame =
  | { t: 'msg'; from: string; body: string; replyTo?: string; hop?: number }
  | { t: 'ping'; from: string };

/** One-line JSON reply to a {@link PeerFrame}. */
export interface PeerReply {
  ok: boolean;
  outcome?: string;
  name?: string;
  error?: string;
}
