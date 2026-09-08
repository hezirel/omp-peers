/**
 * Outbound delivery — name→socket send. Never throws into the agent turn:
 * every failure (unknown name, refused relay, dead socket, timeout) resolves
 * to a human-readable text receipt. Dead sockets reap the stale presence
 * record on sight so the next `/peers` is accurate.
 */

import { requestPeer } from './server.js';
import type { PeerRecord } from '../types.js';

export interface OutboundDeps {
  ownName: string;
  hop?: number;
  replyTo?: string;
  listPeers: () => Promise<PeerRecord[]>;
  reap?: (record: PeerRecord) => Promise<void> | void;
}

/** Send one message to the peer named `to`. Never throws. */
export async function sendToPeer(
  to: string,
  message: string,
  deps: OutboundDeps
): Promise<string> {
  const name = to?.trim() ?? '';
  const body = message?.trim() ?? '';
  if (name === '' || body === '') return 'Both `to` and `message` are required.';
  if (name === 'all') return 'Broadcasts are not supported in v1 — address one peer by name (see `/peers`).';
  if (name === deps.ownName) return 'Cannot send a message to yourself.';
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
      hop: deps.hop ?? 0,
    });
    if (reply === undefined) {
      try {
        await deps.reap?.(record);
      } catch {
        // Reaping is best-effort.
      }
      return `No response from ${name} (socket closed).`;
    }
    if (!reply.ok) return `Delivery to ${name} failed: ${reply.error ?? 'unknown error'}`;
    return `Delivered to ${name} (${reply.outcome ?? 'injected'}). Its reply will arrive as a peer message.`;
  } catch (err) {
    return `Delivery to ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
