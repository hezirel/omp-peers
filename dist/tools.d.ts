/**
 * Agent tool surface: exactly ONE tool, `peer_send`.
 *
 * Registered UNCONDITIONALLY in every mode: on omp hosts the bridge carries
 * peers as native `hub` refs, but those are best-effort (the bridge may bind
 * a foreign registry copy on compiled hosts), so `peer_send {to, message,
 * replyTo?}` is THE guaranteed agent path everywhere. Explicit names only —
 * `to:"all"` is refused.
 */
import type { ExtensionHostLike } from './peers/host.js';
export interface PeerSendDeps {
    send: (to: string, message: string, replyTo?: string) => Promise<string>;
}
export declare function registerPeerSendTool(pi: ExtensionHostLike, deps: PeerSendDeps): void;
