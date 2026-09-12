/**
 * Agent tool surface: `peer_send` plus activity/todo and request/reply tools.
 *
 * Registered UNCONDITIONALLY in every mode: on omp hosts the bridge carries
 * peers as native `hub` refs, but those are best-effort (the bridge may bind
 * a foreign registry copy on compiled hosts), so `peer_send {to, message,
 * replyTo?}` is THE guaranteed agent path everywhere. The new `peer_status`,
 * `peer_todo`, and `peer_request` tools ride the same socket + heartbeat
 * surface. Explicit names only — `to:"all"` is refused.
 */
import type { ExtensionHostLike } from './peers/host.js';
import type { OutboundDeps } from './peers/outbound.js';
import type { PeerRecord, PeerTodo, PendingReply } from './types.js';
export interface PeerSendDeps {
    send: (to: string, message: string, replyTo?: string) => Promise<string>;
}
export declare function registerPeerSendTool(pi: ExtensionHostLike, deps: PeerSendDeps): void;
export interface PeerStatusDeps {
    listPeers: () => Promise<PeerRecord[]>;
    now?: () => number;
}
export declare function registerPeerStatusTool(pi: ExtensionHostLike, deps: PeerStatusDeps): void;
export interface PeerTodoDeps {
    get: () => {
        name: string;
        activity?: string;
        todos: PeerTodo[];
    } | undefined;
    set: (opts: {
        activity?: string;
        todos?: PeerTodo[];
    }) => void;
    tick: () => Promise<void> | void;
}
export declare function registerPeerTodoTool(pi: ExtensionHostLike, deps: PeerTodoDeps): void;
export interface PeerRequestDeps {
    ownName: () => string;
    getHop: () => number;
    send: (to: string, message: string, deps: OutboundDeps) => Promise<string>;
    listPeers: () => Promise<PeerRecord[]>;
    getPendingReplies: () => Map<string, PendingReply> | undefined;
    getNow?: () => number;
}
export declare function registerPeerRequestTool(pi: ExtensionHostLike, deps: PeerRequestDeps): void;
