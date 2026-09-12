/**
 * peers OMP/pi extension entry.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat — no join/leave/channels. On omp the
 * bridge materializes peers as native `hub` refs (best-effort where the
 * registry is shared); one `peer_send` tool registers in EVERY mode as the
 * guaranteed agent path. Explicit names only, no `to:all` in v1.
 *
 * Peer name = session name: the host's builtin `/rename <name>` is the only
 * naming surface. A raw session name is adopted as the peer address when it
 * matches `^[\w.-]{1,24}$`; anything else keeps the default name (one
 * popup warning per process — later ones log only, so model-written
 * auto-titles don't nag on every change).
 *
 * Session discipline: NOTHING session-shaped is captured at boot or in the
 * factory closure. The freshest `{pi, ctx}` is re-read from the live getter
 * on every delivery tick (updated by every host event below), and the own
 * agent id is re-discovered per delivery and cross-checked against
 * `sessionManager.getSessionId()`.
 */
import { registerPeersCommand } from './commands/peers.js';
import { bridgeResolvesHost, claimBridgedPeer, listLocalAgentIds, peerActivityFor, probeHost, readTitleSource, releaseBridgedPeer, } from './peers/host.js';
import { defaultPeerName, isValidPeerName, peerNameFromSession, resolvePeerName } from './peers/ids.js';
import { deliverInboundPeerMessage, HOLD_POLL_MS, MAX_HELD_BATCHES } from './peers/inbound.js';
import { sendToPeer } from './peers/outbound.js';
import { HEARTBEAT_MS, listLivePeers, removePeerRecord, startPresenceBeat, writePeerBeat, } from './peers/presence.js';
import { appendNoteToMessages, buildPeersNote } from './peers/roster.js';
import { peerSocketAddress, requestPeer, startPeerServer } from './peers/server.js';
import { ensureStateDirs, resolveStateDir } from './store/paths.js';
import { registerPeerSendTool } from './tools.js';
/** Module-scope host probe: caches MODULE handles only, never sessions. */
const probe = await probeHost();
const HARNESS = probe.kind === 'hub-bridge' ? 'omp' : 'pi';
const MODE = probe.kind === 'hub-bridge' ? 'hub' : 'tools';
const BRIDGE = probe.kind === 'hub-bridge' ? probe.bridge : undefined;
/** One node per process, even when several sessions load the extension. */
let node;
function currentOf() {
    return node?.stopped === false ? node.current : undefined;
}
/** Stash a held batch (bounded) and ensure the retry poller runs. */
function holdBatch(st, msg) {
    st.held.push({ message: { ...msg }, receivedAt: Date.now() });
    while (st.held.length > MAX_HELD_BATCHES) {
        // Overflow drops the oldest batch — the sender got a 'held' receipt
        // promising delivery, so the drop must not be silent.
        const dropped = st.held.shift();
        if (dropped !== undefined) {
            warnOf(st, `peers: held queue full — dropped a message from ${dropped.message.from}`);
        }
    }
    if (st.holdTimer !== undefined)
        return;
    st.holdTimer = setInterval(() => {
        void pumpHeld(st).catch((err) => logOf(st, `peers: held retry failed: ${err instanceof Error ? err.message : String(err)}`));
    }, HOLD_POLL_MS);
    st.holdTimer.unref?.();
}
/** Retry held batches oldest-first; drop each once it delivers or ages out. */
async function pumpHeld(st) {
    if (st.stopped || node !== st)
        return;
    for (const batch of [...st.held]) {
        if (st.stopped || node !== st)
            return;
        const res = await deliverInboundPeerMessage(batch.message, {
            getCurrent: () => currentOf(),
            getDraftText: () => {
                try {
                    const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
                    return typeof text === 'string' ? text : '';
                }
                catch {
                    return '';
                }
            },
            receivedAt: batch.receivedAt,
            wakes: st.wakes,
        });
        // Only a real delivery advances the relay chain — 'held'/'dropped'/'aside'
        // never reached the agent, so they must not consume a hop.
        if (res.outcome === 'woken' || res.outcome === 'injected') {
            st.inboundHop = batch.message.hop;
        }
        if (res.outcome !== 'held')
            st.held = st.held.filter((b) => b !== batch);
    }
    if (st.held.length === 0 && st.holdTimer !== undefined) {
        clearInterval(st.holdTimer);
        st.holdTimer = undefined;
    }
}
function warnOf(st, text) {
    try {
        st.current?.ctx.ui.notify(text, 'warning');
    }
    catch {
        // Warnings never throw into the host.
    }
}
/**
 * Roster/delivery mode reflects reality: a bridge over a foreign registry
 * copy cannot resolve host refs, so neither the roster note nor the reply
 * hint may promise `hub` op=send. See bridgeResolvesHost.
 */
function rosterMode() {
    return BRIDGE !== undefined && bridgeResolvesHost(BRIDGE) ? 'hub' : 'tools';
}
function logOf(st, text) {
    try {
        st.current?.pi.logger?.warn(text);
    }
    catch {
        // Logging never throws into the host.
    }
}
async function tick(st) {
    const ctx = st.current?.ctx;
    const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
    let sessionId = '';
    try {
        sessionId = ctx?.sessionManager?.getSessionId?.() ?? '';
    }
    catch {
        sessionId = '';
    }
    let model = '';
    try {
        model = ctx?.model?.id ?? '';
    }
    catch {
        model = '';
    }
    let busy = false;
    try {
        busy = !(ctx?.isIdle?.() ?? true);
    }
    catch {
        busy = false;
    }
    let sessionName;
    try {
        sessionName = st.current?.pi.getSessionName?.();
    }
    catch {
        sessionName = undefined;
    }
    if (sessionName === undefined) {
        try {
            sessionName = ctx?.sessionManager?.getSessionName?.();
        }
        catch {
            sessionName = undefined;
        }
    }
    // The host marks model-generated titles `"auto"`: those are never peer
    // addresses (no user intent, rewritten on replan) — peerNameFromSession
    // falls back to the default silently instead of warning.
    const derived = peerNameFromSession(sessionName, cwd, st.pid, {
        titleSource: readTitleSource(ctx?.sessionManager),
    });
    if (derived.rejected !== undefined && derived.rejected !== st.lastRejectedSessionName) {
        const first = st.lastRejectedSessionName === undefined;
        st.lastRejectedSessionName = derived.rejected;
        const text = `session name "${derived.rejected}" can't be a peer name (1-24 of a-z A-Z 0-9 _ . -); ` +
            `using ${derived.name} — /rename the session to a valid name`;
        if (first)
            warnOf(st, text);
        else
            logOf(st, `peers: ${text}`);
    }
    const base = derived.name;
    let others;
    try {
        others = (await listLivePeers(st.stateDir, st.pid)).filter((p) => p.pid !== st.pid);
    }
    catch {
        // Transient listing failure: fall back to the last-good roster below
        // and skip the bridge sync — never release claims on a failed listing.
        others = undefined;
    }
    let localIds = [];
    if (BRIDGE !== undefined) {
        try {
            localIds = listLocalAgentIds(BRIDGE.registry);
        }
        catch {
            localIds = [];
        }
    }
    st.name = resolvePeerName({
        candidate: base,
        pid: st.pid,
        startedAt: st.startedAt,
        peers: others ?? st.peers.filter((p) => p.pid !== st.pid),
        localIds,
    });
    st.sessionId = sessionId;
    let own;
    try {
        own = await writePeerBeat({
            stateDir: st.stateDir,
            pid: st.pid,
            name: st.name,
            cwd,
            harness: HARNESS,
            ...(sessionId !== '' ? { sessionId } : {}),
            ...(model !== '' ? { model } : {}),
            socket: st.socketAddress,
            startedAt: st.startedAt,
            busy,
        });
    }
    catch (err) {
        logOf(st, `peers: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const lastOthers = st.peers.filter((p) => p.pid !== st.pid);
    st.peers =
        own !== undefined
            ? [...(others ?? lastOthers), own].sort((a, b) => a.name.localeCompare(b.name))
            : (others ?? lastOthers);
    if (BRIDGE !== undefined && others !== undefined)
        syncBridge(st, others);
}
function syncBridge(st, others) {
    // A foreign registry copy (compiled omp binary) never resolves the host's
    // own refs — claiming stubs there is invisible to the host `hub` and the
    // roster must not promise it. See bridgeResolvesHost.
    if (BRIDGE === undefined || !bridgeResolvesHost(BRIDGE))
        return;
    const seen = new Set();
    for (const record of others) {
        seen.add(record.name);
        if (!st.claimed.has(record.name)) {
            const ok = claimBridgedPeer(BRIDGE, record, st.name, () => (st.inboundHop === undefined ? 0 : st.inboundHop + 1), (socket, frame) => requestPeer(socket, frame), (text) => {
                // A persistent name collision would re-warn every tick — once per
                // name is enough; the entry clears if the claim later succeeds.
                if (st.claimWarned.has(record.name))
                    return;
                st.claimWarned.add(record.name);
                logOf(st, text);
            });
            if (ok) {
                st.claimed.add(record.name);
                st.claimWarned.delete(record.name);
            }
        }
        // Refresh activity every tick, not just on first claim — '(working)' and
        // cwd go stale otherwise. Only for refs we own: a failed claim means a
        // local agent holds the name and its activity is not ours to write.
        if (st.claimed.has(record.name)) {
            try {
                BRIDGE?.registry.setActivity?.(record.name, peerActivityFor(record));
            }
            catch {
                // Activity updates are best-effort.
            }
        }
    }
    for (const name of [...st.claimed]) {
        if (seen.has(name))
            continue;
        if (BRIDGE !== undefined)
            releaseBridgedPeer(BRIDGE, name);
        st.claimed.delete(name);
        st.claimWarned.delete(name);
    }
}
function armBeatTimer(st, ctx) {
    try {
        st.stopBeat?.();
    }
    catch {
        // Replacing a dead timer must not break re-arm.
    }
    const managed = typeof ctx.setInterval === 'function' && typeof ctx.clearTimer === 'function'
        ? { setInterval: ctx.setInterval.bind(ctx), clearTimer: ctx.clearTimer.bind(ctx) }
        : {};
    st.stopBeat = startPresenceBeat(() => tick(st), {
        intervalMs: HEARTBEAT_MS,
        onError: (err) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`),
        ...managed,
    }).stop;
}
/** Get the live node, starting one if this process has none. Re-arms on every event. */
function ensureNode(pi, ctx) {
    if (node !== undefined && !node.stopped) {
        node.current = { pi, ctx };
        let sessionId = '';
        try {
            sessionId = ctx.sessionManager?.getSessionId?.() ?? '';
        }
        catch {
            sessionId = '';
        }
        if (sessionId !== '' && sessionId !== node.sessionId)
            armBeatTimer(node, ctx);
        return node;
    }
    try {
        const stateDir = resolveStateDir();
        const st = {
            stateDir,
            pid: process.pid,
            startedAt: Date.now(),
            socketAddress: peerSocketAddress(stateDir, process.pid),
            name: '',
            sessionId: '',
            peers: [],
            claimed: new Set(),
            claimWarned: new Set(),
            wakes: new Map(),
            inboundHop: undefined,
            held: [],
            holdTimer: undefined,
            current: { pi, ctx },
            server: undefined,
            stopBeat: undefined,
            lastRejectedSessionName: undefined,
            stopped: false,
        };
        st.name = defaultPeerName(typeof ctx.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd(), st.pid);
        node = st;
        void ensureStateDirs(stateDir)
            .then(() => {
            if (st.stopped)
                return;
            st.server = startPeerServer({
                address: st.socketAddress,
                ownName: () => (node !== undefined && !node.stopped ? node.name : ''),
                onMessage: async (msg) => {
                    const live = node !== undefined && !node.stopped ? node : undefined;
                    const res = await deliverInboundPeerMessage(msg, {
                        getCurrent: () => currentOf(),
                        getDraftText: () => {
                            try {
                                const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
                                return typeof text === 'string' ? text : '';
                            }
                            catch {
                                return '';
                            }
                        },
                        ...(live !== undefined ? { wakes: live.wakes } : {}),
                    });
                    // Only a real delivery advances the relay chain — 'held'/'dropped'/
                    // 'aside' never reached the agent, so they must not consume a hop.
                    if ((res.outcome === 'woken' || res.outcome === 'injected') && live !== undefined) {
                        live.inboundHop = msg.hop;
                    }
                    if (res.outcome === 'held' && live !== undefined)
                        holdBatch(live, msg);
                    return res.outcome;
                },
                onWarn: (text) => {
                    if (node !== undefined && !node.stopped)
                        warnOf(node, text);
                },
            });
            armBeatTimer(st, ctx);
            void tick(st);
        })
            .catch((err) => {
            try {
                ctx.ui.notify(`peers: could not start — ${err instanceof Error ? err.message : String(err)}`, 'warning');
            }
            catch {
                // Boot failures never throw into the host.
            }
        });
        return st;
    }
    catch (err) {
        node = undefined;
        try {
            pi.logger?.warn(`peers: could not start (${String(err)})`);
        }
        catch {
            // Logging never throws.
        }
        return undefined;
    }
}
async function stopNode(st) {
    st.stopped = true;
    // A successor node for this same pid may already exist (session_switch →
    // ensureNode after `node` was cleared). When it does, this teardown must
    // not delete the successor's live record or socket file.
    const hasSuccessor = () => node !== undefined && node !== st && !node.stopped;
    try {
        st.stopBeat?.();
    }
    catch {
        // Shutdown never throws.
    }
    st.stopBeat = undefined;
    if (st.holdTimer !== undefined) {
        try {
            clearInterval(st.holdTimer);
        }
        catch {
            // Shutdown never throws.
        }
        st.holdTimer = undefined;
    }
    if (st.held.length > 0) {
        logOf(st, `peers: dropping ${st.held.length} held message(s) on shutdown`);
    }
    st.held = [];
    try {
        st.server?.stop({ unlinkSocket: !hasSuccessor() });
    }
    catch {
        // Shutdown never throws.
    }
    st.server = undefined;
    if (BRIDGE !== undefined) {
        for (const name of st.claimed)
            releaseBridgedPeer(BRIDGE, name);
        st.claimed.clear();
        st.claimWarned.clear();
    }
    if (hasSuccessor())
        return;
    try {
        await removePeerRecord(st.stateDir, st.pid);
    }
    catch {
        // Final unlink is best-effort.
    }
}
export default function peersExtension(pi) {
    registerPeersCommand(pi, async () => {
        const st = node !== undefined && !node.stopped ? node : undefined;
        if (st !== undefined) {
            // Fresh beat before rendering: a just-run /rename must be visible
            // immediately, not on the next 15s tick. tick() owns its failures.
            try {
                await tick(st);
            }
            catch {
                // Snapshot stays last-good.
            }
            return { ownName: st.name, mode: rosterMode(), peers: st.peers, held: st.held.length };
        }
        return { ownName: '', mode: rosterMode(), peers: [], held: 0 };
    });
    // NOTE: `peer_send` registers UNCONDITIONALLY in every mode. The bridge may
    // bind a foreign registry copy on compiled hosts, making native `hub` refs
    // best-effort only — `peer_send` (socket → far-end `sendUserMessage`) is the
    // guaranteed reply path in ALL modes.
    registerPeerSendTool(pi, {
        send: (to, message, replyTo) => {
            const st = node !== undefined && !node.stopped ? node : undefined;
            return sendToPeer(to, message, {
                ownName: st?.name ?? '',
                hop: st?.inboundHop === undefined ? 0 : st.inboundHop + 1,
                // st.peers includes our own record — filter by pid so a stale own
                // name (post-/rename) can't route a send back to ourselves.
                listPeers: async () => (st?.peers ?? []).filter((p) => p.pid !== st?.pid),
                ...(replyTo !== undefined ? { replyTo } : {}),
                reap: (record) => {
                    if (st !== undefined)
                        void removePeerRecord(st.stateDir, record.pid);
                },
            });
        },
    });
    pi.on('session_start', (_event, ctx) => {
        ensureNode(pi, ctx);
    });
    pi.on('session_shutdown', () => {
        const st = node;
        node = undefined;
        if (st !== undefined)
            void stopNode(st);
    });
    for (const event of ['session_switch', 'session_branch', 'session_tree']) {
        pi.on(event, (_payload, ctx) => {
            ensureNode(pi, ctx);
        });
    }
    pi.on('input', (event) => {
        const source = event?.source;
        if (source === 'extension')
            return;
        // A human prompt ends any relay chain: the next send starts at hop 0.
        // (No re-beat here: the context handler builds the roster from the last
        // good tick, so an async beat could never land in time for this prompt.)
        if (node !== undefined && !node.stopped)
            node.inboundHop = undefined;
    });
    // `input` only fires for interactive TTY submits — on rpc/print/headless
    // hosts it never runs, so `before_agent_start` (emitted by the agent loop
    // in every mode) is the reset that keeps inboundHop from sticking forever.
    // Peer injections are identified by the `[peer <name>]` prefix
    // formatPeerText stamps on every delivery; a human prompt that happens to
    // start with `[peer ` won't reset — conservative direction, acceptable.
    pi.on('before_agent_start', (event) => {
        const prompt = event?.prompt;
        if (typeof prompt === 'string' && prompt.startsWith('[peer '))
            return;
        if (node !== undefined && !node.stopped)
            node.inboundHop = undefined;
    });
    pi.on('context', (event, ctx) => {
        const st = ensureNode(pi, ctx);
        if (st === undefined)
            return undefined;
        // Hot-rename: recompute the name from the LIVE session name before
        // building the note — the async re-beat may not have landed yet, and
        // the first prompt after /rename must not show a stale name.
        const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
        let sessionName;
        try {
            sessionName = pi.getSessionName?.() ?? ctx?.sessionManager?.getSessionName?.();
        }
        catch {
            sessionName = undefined;
        }
        // Auto-titles never claim the peer name, even valid-looking ones: the
        // host rewrites them, which would flap the address mid-life.
        if (sessionName !== undefined && isValidPeerName(sessionName) && readTitleSource(ctx?.sessionManager) !== 'auto') {
            const others = st.peers.filter((p) => p.pid !== st.pid);
            let localIds = [];
            if (BRIDGE !== undefined) {
                try {
                    localIds = listLocalAgentIds(BRIDGE.registry);
                }
                catch {
                    localIds = [];
                }
            }
            st.name = resolvePeerName({
                candidate: sessionName,
                pid: st.pid,
                startedAt: st.startedAt,
                peers: others,
                localIds,
            });
        }
        // Always inject: the agent learns its OWN peer name here, even solo.
        const others = st.peers.filter((p) => p.pid !== st.pid);
        const note = buildPeersNote(st.name, others, rosterMode());
        const payload = event;
        if (payload === undefined || !Array.isArray(payload.messages))
            return undefined;
        return { messages: appendNoteToMessages(payload.messages, note) };
    });
}
