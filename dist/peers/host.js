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
/**
 * True when the probed registry is the HOST's own (shared) copy. The host
 * always keeps its driving agent registered, so a shared copy resolves
 * `Main`; a foreign module copy — which the compiled omp binary hands to
 * dynamic importers — has an empty map and nothing we claim there is
 * visible to the host's `hub`. Bridges that fail this probe must not claim
 * refs or promise `hub send` in the roster.
 */
export function bridgeResolvesHost(bridge) {
    try {
        // 'Main' is the host driving agent's registry id — a presence probe,
        // never a delivery address (see ids.ts REFUSED_HOST_NAME).
        return bridge.registry.get('Main') !== undefined;
    }
    catch {
        return false;
    }
}
/**
 * `executeSend` reads `settings` only to resolve an await timeout
 * (`params.await`), which the inbound path never sets. A real
 * SettingsManager is unreachable from an extension, so this stands in.
 */
export const SETTINGS_STUB = {
    get: (_key) => undefined,
};
/**
 * Capability probe. Literal specifiers only (the host rewrites them), always
 * inside try/catch: on any host without these modules this resolves
 * `{kind:'tools'}` and the extension falls back to the `peer_send` surface.
 * The result caches host MODULE handles only — never any session object.
 */
export async function probeHost() {
    try {
        const registryModule = (await import('@oh-my-pi/pi-coding-agent/registry/agent-registry'));
        const messagingModule = (await import('@oh-my-pi/pi-coding-agent/tools/hub/messaging'));
        const agentRegistry = registryModule['AgentRegistry'];
        const send = messagingModule['executeSend'];
        if (typeof agentRegistry?.global !== 'function' || typeof send !== 'function') {
            return { kind: 'tools' };
        }
        return {
            kind: 'hub-bridge',
            bridge: { registry: agentRegistry.global(), send: send },
        };
    }
    catch {
        return { kind: 'tools' };
    }
}
function registryRefs(registry) {
    try {
        if (typeof registry.values === 'function')
            return [...registry.values()];
        if (typeof registry.list === 'function') {
            const out = registry.list();
            return Array.isArray(out) ? out : [];
        }
        if (typeof registry.entries === 'function') {
            return [...registry.entries()].map(([, v]) => v);
        }
    }
    catch {
        return [];
    }
    return [];
}
/**
 * Find OURSELVES in the HOST registry: first by live session object identity
 * (when the host exposes it on ctx), then by session-file/session-id match
 * against `sessionManager.getSessionId()`. NEVER by name — peer names are
 * explicitly non-unique across processes. Returns undefined when nothing
 * matches; the caller drops (never misdelivers).
 */
export function discoverOwnAgentId(registry, ctx) {
    let sessionId = '';
    try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? '';
    }
    catch {
        sessionId = '';
    }
    const liveSession = ctx['session'];
    const refs = registryRefs(registry);
    if (liveSession !== undefined && liveSession !== null) {
        for (const ref of refs) {
            if (ref.session === liveSession && typeof ref.id === 'string' && ref.id !== '') {
                return ref.id;
            }
        }
    }
    if (sessionId !== '') {
        for (const ref of refs) {
            if (typeof ref.id !== 'string' || ref.id === '')
                continue;
            const file = typeof ref.sessionFile === 'string' ? ref.sessionFile : '';
            const sid = typeof ref.sessionId === 'string' ? ref.sessionId : '';
            if (ref.id === sessionId || (file !== '' && file.includes(sessionId)) || sid === sessionId) {
                return ref.id;
            }
        }
    }
    return undefined;
}
/**
 * `peerSocket` marker). Used to keep a session name from colliding with a
 * live subagent address during peer-name deconfliction.
 */
export function listLocalAgentIds(registry) {
    const ids = [];
    for (const ref of registryRefs(registry)) {
        if (typeof ref.id !== 'string' || ref.id === '')
            continue;
        const session = ref.session;
        if (session !== null && typeof session === 'object' && session.peerSocket !== undefined) {
            continue;
        }
        ids.push(ref.id);
    }
    return ids;
}
/**
 * Who named this session. The host marks explicit renames `"user"` and
 * model-generated titles `"auto"` on the session header (on-contract via
 * `ReadonlySessionManager.getHeader`) and on the manager itself (structural —
 * the runtime object is the full SessionManager). Returns undefined when the
 * host exposes neither; callers keep legacy adopt-or-warn behavior.
 */
export function readTitleSource(manager) {
    if (manager === undefined || manager === null)
        return undefined;
    // Header first (on-contract), then the manager itself (structural) — first
    // non-empty string wins. Every read is guarded: unknown host shapes fall
    // through to undefined and callers keep legacy adopt-or-warn behavior.
    const candidates = [];
    try {
        candidates.push(manager.getHeader?.());
    }
    catch {
        // Header read is best-effort.
    }
    candidates.push(manager);
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null)
            continue;
        if (!('titleSource' in candidate))
            continue;
        const source = candidate.titleSource;
        if (typeof source === 'string' && source !== '')
            return source;
    }
    return undefined;
}
export function peerActivityFor(record) {
    return `${record.harness} instance pid ${record.pid} in ${record.cwd}${record.busy ? ' (working)' : ''}`;
}
/**
 * Materialize a remote peer as a registry ref so native `hub send`/`hub list`
 * reach it. `kind:'sub'` + `status:'idle'` keeps the stub inside the host's
 * flat alive filter and clear of the parked lifecycle gate, so `hub send`
 * goes straight to the stub's `deliverIrcMessage` (socket round trip).
 * Refuses to overwrite a live local (non-peer) ref of the same id.
 */
export function claimBridgedPeer(bridge, record, ownName, getHop, request, onWarn) {
    let existing;
    try {
        existing = bridge.registry.get(record.name);
    }
    catch {
        existing = undefined;
    }
    if (existing !== undefined && existing.session?.peerSocket === undefined) {
        try {
            onWarn?.(`peers: name "${record.name}" collides with a local agent; skipping bridge`);
        }
        catch {
            // Warning delivery is best-effort.
        }
        return false;
    }
    const stub = {
        isStreaming: false,
        peerSocket: record.socket,
        subscribe: () => () => undefined,
        subscribeRunState: () => () => undefined,
        waitForIrcReplies: async () => [],
        deliverIrcMessage: async (msg) => {
            const reply = await request(record.socket, {
                t: 'msg',
                from: ownName,
                body: msg.body,
                ...(msg.replyTo !== undefined && msg.replyTo !== '' ? { replyTo: msg.replyTo } : {}),
                hop: getHop(),
            });
            return reply?.outcome === 'woken' ? 'woken' : 'injected';
        },
    };
    try {
        bridge.registry.register({
            id: record.name,
            displayName: `${record.name} · ${record.project}`,
            kind: 'sub',
            status: 'idle',
            session: stub,
            sessionFile: null,
            activity: peerActivityFor(record),
        });
    }
    catch {
        return false;
    }
    return true;
}
/** Release a bridged peer ref, but only one this extension owns (marker). */
export function releaseBridgedPeer(bridge, name) {
    try {
        const ref = bridge.registry.get(name);
        if (ref?.session?.peerSocket === undefined)
            return;
        bridge.registry.unregister(name);
    }
    catch {
        // Release is best-effort.
    }
}
