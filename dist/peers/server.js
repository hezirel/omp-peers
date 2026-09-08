/**
 * Socket transport between peer processes.
 *
 * Address seam: Windows serves a named pipe (`\\.\pipe\peers-<pid>`),
 * everywhere else a unix socket (`<state>/peers/<pid>.sock`). Both sides go
 * through `node:net` with a plain string address, so one code path covers
 * both. Frames are newline-delimited JSON (`PeerFrame`); every frame gets a
 * one-line `PeerReply`.
 *
 * Inbound policy lives here: hop cap (4 — a chain of agent-to-agent relays
 * past a human prompt is refused, never relayed) and 400ms per-sender burst
 * coalescing (N frames in one window cost one wake, not N).
 */
import { createConnection, createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { peersDir } from '../store/paths.js';
/** Max agent-to-agent relays from the last human prompt before refusal. */
export const MAX_HOPS = 4;
/** Burst window: frames from one sender inside it become a single wake. */
export const COALESCE_MS = 400;
/** Socket round-trip timeout for outbound sends. */
export const PEER_REQUEST_TIMEOUT_MS = 8_000;
/** Where this peer listens (and where others reach it). */
export function peerSocketAddress(stateDir, pid) {
    if (process.platform === 'win32')
        return `\\\\.\\pipe\\peers-${pid}`;
    return `${peersDir(stateDir)}/${pid}.sock`;
}
function normalizeHop(hop) {
    return typeof hop === 'number' && Number.isFinite(hop) ? Math.max(0, Math.trunc(hop)) : 0;
}
function reply(socket, payload) {
    try {
        if (!socket.destroyed)
            socket.write(`${JSON.stringify(payload)}\n`);
    }
    catch {
        // Reply delivery is best-effort; the sender already treats close as failure.
    }
}
/**
 * Serve one peer address. `onMessage` runs once per coalesced batch and its
 * return becomes the reply `outcome`. Never throws into the host.
 */
export function startPeerServer(opts) {
    const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    const pending = new Map();
    let stopped = false;
    let server;
    async function deliverBatch(from, first) {
        if (stopped)
            return;
        await new Promise((resolve) => {
            const wait = setTimeout(resolve, coalesceMs);
            wait.unref?.();
        });
        const batch = pending.get(from) ?? { bodies: [], hop: 0 };
        pending.delete(from);
        const bodies = batch.bodies.length > 0 ? batch.bodies : [''];
        const body = bodies.length === 1
            ? bodies[0]
            : `${bodies.length} messages arrived together:\n\n${bodies
                .map((entry, index) => `${index + 1}. ${entry}`)
                .join('\n\n')}`;
        try {
            const outcome = await opts.onMessage({
                from,
                body,
                ...(batch.replyTo !== undefined ? { replyTo: batch.replyTo } : {}),
                hop: batch.hop,
            });
            reply(first, { ok: true, outcome });
        }
        catch (err) {
            pending.delete(from);
            reply(first, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    }
    async function handleFrame(line, socket) {
        let frame;
        try {
            frame = JSON.parse(line);
        }
        catch {
            reply(socket, { ok: false, error: 'bad frame' });
            return;
        }
        if (frame.t === 'ping') {
            reply(socket, { ok: true, name: opts.ownName() });
            return;
        }
        if (frame.t !== 'msg') {
            reply(socket, { ok: false, error: 'unknown frame' });
            return;
        }
        const hop = normalizeHop(frame.hop);
        if (hop > MAX_HOPS) {
            try {
                opts.onWarn?.(`peers: refused a message from ${frame.from} — hop ${hop} exceeds the ${MAX_HOPS}-hop chain limit`);
            }
            catch {
                // Warning delivery is best-effort.
            }
            reply(socket, {
                ok: false,
                error: `Refused: this message is ${hop} hops from a human prompt and the limit is ${MAX_HOPS}. The chain has to end here — do not resend. Ask your user if it must continue.`,
            });
            return;
        }
        if (typeof frame.from !== 'string' || frame.from === '' || typeof frame.body !== 'string') {
            reply(socket, { ok: false, error: 'bad frame' });
            return;
        }
        const known = pending.get(frame.from);
        if (known) {
            known.bodies.push(frame.body);
            known.hop = Math.min(known.hop, hop);
            reply(socket, { ok: true, outcome: 'coalesced' });
            return;
        }
        pending.set(frame.from, {
            bodies: [frame.body],
            ...(typeof frame.replyTo === 'string' && frame.replyTo !== '' ? { replyTo: frame.replyTo } : {}),
            hop,
        });
        void deliverBatch(frame.from, socket);
    }
    function accept(socket) {
        socket.on('error', () => {
            try {
                socket.destroy();
            }
            catch {
                // Destroy is best-effort.
            }
        });
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += String(chunk);
            let index = buffer.indexOf('\n');
            while (index !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
                void handleFrame(line, socket);
            }
        });
    }
    server = createServer(accept);
    server.on('error', (err) => {
        try {
            opts.onWarn?.(`peers: server error: ${err instanceof Error ? err.message : String(err)}`);
        }
        catch {
            // Warning delivery is best-effort.
        }
    });
    server.unref();
    const address = opts.address;
    void (async () => {
        try {
            if (process.platform !== 'win32') {
                await rm(address, { force: true }).catch(() => undefined);
            }
            server?.listen(address);
        }
        catch (err) {
            try {
                opts.onWarn?.(`peers: failed to listen on ${address}: ${err instanceof Error ? err.message : String(err)}`);
            }
            catch {
                // Warning delivery is best-effort.
            }
        }
    })();
    return {
        address,
        stop: () => {
            stopped = true;
            try {
                server?.close();
            }
            catch {
                // Close is best-effort.
            }
            server = undefined;
            if (process.platform !== 'win32') {
                void rm(address, { force: true }).catch(() => undefined);
            }
        },
    };
}
/**
 * One request/response round trip to a peer socket. Resolves `undefined`
 * when the socket closes before replying (peer gone — caller reaps).
 */
export function requestPeer(address, frame, timeoutMs = PEER_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const socket = createConnection(address);
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            try {
                socket.destroy();
            }
            catch {
                // Destroy is best-effort.
            }
            resolve(value);
        };
        timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
        timer.unref?.();
        socket.on('error', (err) => {
            finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
        socket.on('connect', () => {
            try {
                socket.write(`${JSON.stringify(frame)}\n`);
            }
            catch (err) {
                finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        });
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += String(chunk);
            const index = buffer.indexOf('\n');
            if (index === -1)
                return;
            try {
                finish(JSON.parse(buffer.slice(0, index)));
            }
            catch {
                finish({ ok: false, error: 'bad response' });
            }
        });
        socket.on('close', () => finish(undefined));
    });
}
