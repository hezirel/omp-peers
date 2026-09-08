/**
 * Presence — one owner-written heartbeat file per peer process.
 *
 * `<state>/peers/<pid>.json` is written via `durableWriteJson` (sidecar +
 * fsync + copy-over, never a rename over a live file) on a 15s beat. A peer
 * is live while its beat is at most 45s old AND its pid answers
 * `process.kill(pid, 0)`. Stale records are reaped (unlinked on sight).
 * Shutdown unlinks the own record.
 */
import type { HarnessKind, PeerRecord } from '../types.js';
export declare const HEARTBEAT_MS = 15000;
export declare const PEER_TTL_MS = 45000;
export interface BeatInput {
    stateDir: string;
    pid?: number;
    name: string;
    cwd: string;
    harness: HarnessKind;
    sessionId?: string;
    model?: string;
    socket: string;
    startedAt: number;
    busy?: boolean;
}
/** Write (or refresh) this process's presence record. Owner-only writer. */
export declare function writePeerBeat(input: BeatInput): Promise<PeerRecord>;
export interface ListPeersOptions {
    now?: number;
    /** Liveness probe seam (default: `process.kill(pid, 0)`). */
    isAlive?: (pid: number) => boolean;
}
/**
 * List live peers, reaping stale records on sight: unparseable/wrong-shape
 * files, dead pids, and beats older than the TTL are unlinked (plus the
 * abandoned unix socket, when the address names one inside the peers dir).
 * Results sort by name.
 */
export declare function listLivePeers(stateDir: string, selfPid: number, opts?: ListPeersOptions): Promise<PeerRecord[]>;
/** Remove one presence record (+ its unix socket on non-Windows). */
export declare function removePeerRecord(stateDir: string, pid: number): Promise<void>;
export interface PresenceBeatOptions {
    intervalMs?: number;
    onError?: (err: unknown) => void;
    /** Host-managed timers (omp) when available; raw unref'd timer otherwise. */
    setInterval?: (callback: () => void, ms?: number) => unknown;
    clearTimer?: (timer: unknown) => void;
}
/**
 * Run `tick` immediately and every `intervalMs`. The tick body never throws
 * into the host: failures route to `onError`. Returns a `stop` handle.
 */
export declare function startPresenceBeat(tick: () => Promise<void> | void, opts?: PresenceBeatOptions): {
    stop(): void;
};
/** `3s ago` / `12m ago` / `2h ago` for the `/peers` beat-age column. */
export declare function formatBeatAge(beatAt: number, now?: number): string;
