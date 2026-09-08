/**
 * Outbound delivery — name→socket send. Never throws into the agent turn:
 * every failure (unknown name, refused relay, dead socket, timeout) resolves
 * to a human-readable text receipt. Dead sockets reap the stale presence
 * record on sight so the next `/peers` is accurate.
 */
import type { PeerRecord } from '../types.js';
export interface OutboundDeps {
    ownName: string;
    hop?: number;
    replyTo?: string;
    listPeers: () => Promise<PeerRecord[]>;
    reap?: (record: PeerRecord) => Promise<void> | void;
}
/** Send one message to the peer named `to`. Never throws. */
export declare function sendToPeer(to: string, message: string, deps: OutboundDeps): Promise<string>;
