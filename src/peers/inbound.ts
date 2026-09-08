/**
 * Inbound delivery — hand a socket message to the LOCAL agent.
 *
 * PRIMARY PATH: `cur.pi.sendUserMessage(text)` on the CURRENT context's pi
 * with default semantics — streaming queues as steer, idle starts a turn,
 * plan mode folds it into context. No registry lookup, no own-agent-id
 * discovery, no drop-for-undiscovered: the host's bus copy is unreachable
 * from a compiled extension, so delivery goes through the extension-host
 * surface that is always live on the current context.
 *
 * STRUCTURAL RULE: the session is NEVER snapshotted at boot. The current
 * `{pi, ctx}` comes from a live getter (refreshed on every host event).
 * Over-budget wakes queue as asides
 * (`pi.sendUserMessage(text, {deliverAs:'aside'})`), as does delivery on a
 * bridgeless host — and always on the CURRENT pi, never a
 * factory-captured one.
 */

import type { CommandContextLike, ExtensionHostLike, HubBridge } from './host.js';

/** Per-peer wakes allowed per rolling hour before excess queues as asides. */
export const MAX_WAKES_PER_PEER_PER_HOUR = 20;
export const WAKE_WINDOW_MS = 3_600_000;

export interface InboundCarrier {
  from: string;
  body: string;
  replyTo?: string;
}

export interface CurrentHost {
  pi: ExtensionHostLike;
  ctx: CommandContextLike;
}

export type InboundOutcome = 'injected' | 'woken' | 'aside' | 'dropped';

export interface InboundDeps {
  /** Live getter for the freshest host handles — called on every delivery. */
  getCurrent: () => CurrentHost | undefined;
  /**
   * Probed bridge, or undefined in tools mode (aside fallback). Retained only
   * for the bridgeless distinction — delivery itself never touches the bus.
   * The bridge's live use is `claimBridgedPeer` roster presence in the host.
   */
  bridge: HubBridge | undefined;
  /** 'hub' when bridged (reply hints name `hub`), else 'tools'. */
  mode: 'hub' | 'tools';
  /** In-memory per-peer wake timestamps; owned by the caller. */
  wakes?: Map<string, number[]>;
  now?: () => number;
}

/** Every injection carries the `[peer <name>]` attribution prefix. */
export function formatPeerText(
  from: string,
  body: string,
  opts: { replyTo?: string; mode?: 'hub' | 'tools' } = {}
): string {
  return [
    `[peer ${from}]${opts.replyTo !== undefined && opts.replyTo !== '' ? ` (reply to ${opts.replyTo})` : ''}:`,
    '',
    body,
    '',
    // Always `peer_send`: it works on every host shape. Even in hub mode the
    // probe may hold a foreign registry copy where `hub` op=send cannot
    // resolve peer names — pointing replies there strands the sender.
    `Reply with \`peer_send\` to="${from}" if a response is useful.`,
  ].join('\n');
}

/** True when `from` already consumed its hourly wake budget (prunes first). */
export function isWakeOverBudget(
  wakes: Map<string, number[]>,
  from: string,
  now: number,
  max: number = MAX_WAKES_PER_PEER_PER_HOUR
): boolean {
  const stamps = wakes.get(from) ?? [];
  const fresh = stamps.filter((t) => now - t < WAKE_WINDOW_MS);
  if (fresh.length !== stamps.length) wakes.set(from, fresh);
  return fresh.length >= max;
}

/** Record one real wake for `from` (prunes expired stamps). */
export function recordPeerWake(wakes: Map<string, number[]>, from: string, now: number): void {
  const stamps = wakes.get(from) ?? [];
  stamps.push(now);
  wakes.set(
    from,
    stamps.filter((t) => now - t < WAKE_WINDOW_MS)
  );
}

function aside(pi: ExtensionHostLike, text: string): void {
  try {
    pi.sendUserMessage?.(text, { deliverAs: 'aside' });
  } catch {
    // Aside fallback is best-effort.
  }
}

function warn(ctx: CommandContextLike, text: string): void {
  try {
    ctx.ui.notify(text, 'warning');
  } catch {
    // Warning delivery is best-effort.
  }
}

/**
 * Deliver one coalesced inbound message. Never throws; the outcome tells the
 * socket layer what receipt to send back.
 */
export async function deliverInboundPeerMessage(
  frame: InboundCarrier,
  deps: InboundDeps
): Promise<{ outcome: InboundOutcome; detail?: string }> {
  const now = deps.now?.() ?? Date.now();
  const cur = deps.getCurrent();
  if (cur === undefined) return { outcome: 'dropped', detail: 'no live session context' };
  const from = frame.from ?? '';
  const body = frame.body ?? '';
  if (from === '' || body === '') return { outcome: 'dropped', detail: 'empty frame' };

  const wakes = deps.wakes ?? new Map<string, number[]>();
  const text = formatPeerText(from, body, { replyTo: frame.replyTo, mode: deps.mode });

  let willWake = true;
  try {
    willWake = cur.ctx.isIdle?.() !== false;
  } catch {
    willWake = true;
  }
  if (willWake && isWakeOverBudget(wakes, from, now)) {
    aside(cur.pi, text);
    return { outcome: 'aside', detail: 'hourly wake budget exceeded' };
  }

  if (deps.bridge === undefined) {
    aside(cur.pi, text);
    return { outcome: 'aside', detail: 'no hub bridge on this host' };
  }

  if (typeof cur.pi.sendUserMessage !== 'function') {
    warn(cur.ctx, `peers: dropped a message from ${from} — the host has no sendUserMessage`);
    return { outcome: 'dropped', detail: 'no sendUserMessage on host' };
  }
  try {
    cur.pi.sendUserMessage(text);
    if (willWake) recordPeerWake(wakes, from, now);
    return { outcome: 'injected' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(cur.ctx, `peers: message from ${from} could not be delivered (${message})`);
    return { outcome: 'dropped', detail: message };
  }
}
