/**
 * Host seam: narrow structural types plus the capability probe.
 *
 * STRUCTURAL RULE (1): never import host singletons (`registry/agent-registry`,
 * `irc/bus`, `tools/hub/messaging`). The extension's module graph may bind a
 * FOREIGN copy of the host modules (two `static #global` instances), so the
 * host is touched ONLY through `ctx`/`pi` surfaces plus the bridge probed
 * below via literal-specifier dynamic imports inside try/catch (the host
 * loader rewrites literal specifiers to the host's own module instances).
 * Future #7401 seams slot in here.
 */
import type { PeerRecord } from '../types.js';
export interface SessionManagerLike {
    getSessionId?: () => string | undefined;
    /** Host session title (omp `ReadonlySessionManager.getSessionName`). */
    getSessionName?: () => string | undefined;
}
export interface SelectOption {
    label: string;
    description?: string;
}
export interface UiLike {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    select?: (title: string, options: SelectOption[], dialogOptions?: unknown) => Promise<string | undefined>;
    [key: string]: unknown;
}
export interface CommandContextLike {
    cwd: string;
    mode: string;
    ui: UiLike;
    sessionManager: SessionManagerLike;
    model?: {
        id?: string;
    };
    isIdle: () => boolean;
    setInterval?: (callback: () => void, ms?: number) => unknown;
    clearTimer?: (timer: unknown) => void;
    [key: string]: unknown;
}
export interface ToolInvokeResult {
    content: Array<{
        type: string;
        text: string;
    }>;
    details?: unknown;
}
export interface ExtensionHostLike {
    on(event: string, handler: (event: unknown, ctx: CommandContextLike) => unknown): void;
    registerCommand(name: string, opts: {
        description?: string;
        handler: (args: string, ctx: CommandContextLike) => unknown;
    }): void;
    registerTool(tool: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolInvokeResult>;
    }): void;
    sendUserMessage?: (content: string, options?: {
        deliverAs?: 'steer' | 'followUp' | 'aside';
    }) => void;
    getSessionName?: () => string | undefined;
    logger?: {
        warn(message: string): void;
    };
}
/** Structural view of one host registry ref (only the fields we read). */
export interface RegistryRefLike {
    id: unknown;
    session?: unknown;
    sessionFile?: unknown;
    sessionId?: unknown;
}
/** Structural view of the HOST AgentRegistry (obtained via probe). */
export interface RegistryLike {
    get(id: string): {
        session?: {
            peerSocket?: unknown;
        } | null;
    } | undefined;
    list?: () => RegistryRefLike[];
    values?: () => Iterable<RegistryRefLike>;
    entries?: () => Iterable<[unknown, RegistryRefLike]>;
    register(input: Record<string, unknown>): unknown;
    unregister(id: string): boolean;
    setActivity?: (id: string, activity: string) => void;
}
/**
 * The host's own `hub` send path (`tools/hub/messaging` `executeSend`), which
 * drives the host's real `IrcBus`: waiter-first so an awaited peer reply
 * resolves, then `session.deliverIrcMessage` into the recipient session.
 */
export type ExecuteSendFn = (deps: {
    registry: unknown;
    senderId: string;
    settings: unknown;
    sessionFileHint: string | null;
}, params: {
    to: string;
    message: string;
    replyTo?: string;
}) => Promise<{
    details?: {
        receipts?: Array<{
            outcome?: string;
            error?: string;
        }>;
    };
}>;
export interface HubBridge {
    registry: RegistryLike;
    send: ExecuteSendFn;
}
/**
 * True when the probed registry is the HOST's own (shared) copy. The host
 * always keeps its driving agent registered, so a shared copy resolves
 * `Main`; a foreign module copy — which the compiled omp binary hands to
 * dynamic importers — has an empty map and nothing we claim there is
 * visible to the host's `hub`. Bridges that fail this probe must not claim
 * refs or promise `hub send` in the roster.
 */
export declare function bridgeResolvesHost(bridge: HubBridge): boolean;
/**
 * `executeSend` reads `settings` only to resolve an await timeout
 * (`params.await`), which the inbound path never sets. A real
 * SettingsManager is unreachable from an extension, so this stands in.
 */
export declare const SETTINGS_STUB: {
    get: (_key?: string) => undefined;
};
export type HostProbe = {
    kind: 'hub-bridge';
    bridge: HubBridge;
} | {
    kind: 'tools';
};
/**
 * Capability probe. Literal specifiers only (the host rewrites them), always
 * inside try/catch: on any host without these modules this resolves
 * `{kind:'tools'}` and the extension falls back to the `peer_send` surface.
 * The result caches host MODULE handles only — never any session object.
 */
export declare function probeHost(): Promise<HostProbe>;
/**
 * Find OURSELVES in the HOST registry: first by live session object identity
 * (when the host exposes it on ctx), then by session-file/session-id match
 * against `sessionManager.getSessionId()`. NEVER by name — peer names are
 * explicitly non-unique across processes. Returns undefined when nothing
 * matches; the caller drops (never misdelivers).
 */
export declare function discoverOwnAgentId(registry: RegistryLike, ctx: CommandContextLike): string | undefined;
/**
 * `peerSocket` marker). Used to keep a session name from colliding with a
 * live subagent address during peer-name deconfliction.
 */
export declare function listLocalAgentIds(registry: RegistryLike): string[];
export declare function peerActivityFor(record: PeerRecord): string;
export type PeerRequestFn = (socket: string, frame: {
    t: 'msg';
    from: string;
    body: string;
    replyTo?: string;
    hop: number;
}) => Promise<{
    ok: boolean;
    outcome?: string;
    error?: string;
} | undefined>;
/**
 * Materialize a remote peer as a registry ref so native `hub send`/`hub list`
 * reach it. `kind:'sub'` + `status:'idle'` keeps the stub inside the host's
 * flat alive filter and clear of the parked lifecycle gate, so `hub send`
 * goes straight to the stub's `deliverIrcMessage` (socket round trip).
 * Refuses to overwrite a live local (non-peer) ref of the same id.
 */
export declare function claimBridgedPeer(bridge: HubBridge, record: PeerRecord, ownName: string, getHop: () => number, request: PeerRequestFn, onWarn?: (message: string) => void): boolean;
/** Release a bridged peer ref, but only one this extension owns (marker). */
export declare function releaseBridgedPeer(bridge: HubBridge, name: string): void;
