/**
 * Peer-name validation and cross-process deconfliction.
 *
 * A peer name is an address: `^[\w.-]{1,24}$`. `Main` is refused
 * (case-sensitive exact match — it names the host's driving agent and must
 * never be taken by a peer), as is any live local subagent id handed in via
 * `localIds`. Cross-process collisions resolve first-wins by `startedAt`;
 * the younger instance auto-suffixes `-<pid>`.
 */
import type { PeerRecord } from '../types.js';
export declare const PEER_NAME_PATTERN: RegExp;
export declare function isValidPeerName(name: string): boolean;
/** Throw {@link PeerNameError} unless `name` is usable as a peer address. */
export declare function validatePeerName(name: string, opts?: {
    localIds?: Iterable<string>;
}): void;
/** Default address for an instance: sanitized `<basename(cwd)>-<pid>`. */
export declare function defaultPeerName(cwd: string, pid: number): string;
/**
 * Derive a peer address from the host session name. A session name qualifies
 * as an address ONLY in raw form: non-empty and matching
 * {@link PEER_NAME_PATTERN} (1-24 of a-z A-Z 0-9 _ . -). Anything else —
 * spaces, model-written auto-titles — falls back to {@link defaultPeerName}
 * with `rejected` carrying the raw name so the caller can warn once.
 * Cross-process collisions still resolve later via {@link resolvePeerName}.
 */
export declare function peerNameFromSession(raw: string | undefined, cwd: string, pid: number): {
    name: string;
    rejected?: string;
};
export interface ResolveNameInput {
    candidate: string;
    pid: number;
    startedAt: number;
    peers: PeerRecord[];
    /** Live local subagent ids — treated as held, like an older peer. */
    localIds?: Iterable<string>;
}
/**
 * First-wins by `startedAt`: when another live peer holds `candidate` and
 * started no later than us (or a local id holds it), take `<candidate>-<pid>`.
 * The suffixed form is intentionally exempt from the 24-char cap so it stays
 * deterministic and searchable.
 */
export declare function resolvePeerName(input: ResolveNameInput): string;
