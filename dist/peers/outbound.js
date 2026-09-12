/**
 * Outbound delivery — name→socket send. Never throws into the agent turn:
 * every failure (unknown name, refused relay, dead socket, timeout) resolves
 * to a human-readable text receipt. Dead sockets reap the stale presence
 * record on sight so the next `/peers` is accurate.
 */
import { MAX_HOPS, requestPeer } from './server.js';
/** Send one message to the peer named `to`. Never throws. */
export async function sendToPeer(to, message, deps) {
    const name = to?.trim() ?? '';
    const body = message?.trim() ?? '';
    if (name === '' || body === '')
        return 'Both `to` and `message` are required.';
    if (name === 'all')
        return 'Broadcasts are not supported in v1 — address one peer by name (see `/peers`).';
    if (name === deps.ownName)
        return 'Cannot send a message to yourself.';
    const hop = deps.hop ?? 0;
    // Same refusal the server would send — checked locally so an over-limit
    // chain never costs a socket round-trip.
    if (hop > MAX_HOPS) {
        return `Refused: this message is ${hop} hops from a human prompt and the limit is ${MAX_HOPS}. The chain has to end here — do not resend. Ask your user if it must continue.`;
    }
    try {
        const peers = await deps.listPeers();
        const record = peers.find((p) => p.name === name);
        if (record === undefined) {
            const known = peers.map((p) => p.name).join(', ') || 'none';
            return `Unknown peer "${name}". Live peers: ${known}`;
        }
        const reply = await requestPeer(record.socket, {
            t: 'msg',
            from: deps.ownName,
            body,
            ...(deps.replyTo !== undefined && deps.replyTo !== '' ? { replyTo: deps.replyTo } : {}),
            hop,
        });
        if (reply === undefined) {
            try {
                await deps.reap?.(record);
            }
            catch {
                // Reaping is best-effort.
            }
            return `No response from ${name} (socket closed).`;
        }
        if (!reply.ok)
            return `Delivery to ${name} failed: ${reply.error ?? 'unknown error'}`;
        if (reply.outcome === 'dropped')
            return `Delivery to ${name} failed (dropped by receiver)`;
        if (reply.outcome === 'aside')
            return `Queued at ${name} (wake budget reached — delivers without waking)`;
        if (reply.outcome === 'coalesced')
            return `Delivered to ${name} (coalesced into a batch). Its reply will arrive as a peer message.`;
        if (reply.outcome === 'held')
            return `Held at ${name} (typing) — delivers when they submit. Its reply will arrive as a peer message.`;
        return `Delivered to ${name} (${reply.outcome ?? 'injected'}). Its reply will arrive as a peer message.`;
    }
    catch (err) {
        return `Delivery to ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}
