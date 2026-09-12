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

import { randomUUID } from 'node:crypto';
import type { ExtensionHostLike } from './peers/host.js';
import { formatBeatAge } from './peers/presence.js';
import type { OutboundDeps } from './peers/outbound.js';
import type { PeerRecord, PeerTodo, PendingReply } from './types.js';

export interface PeerSendDeps {
  send: (to: string, message: string, replyTo?: string) => Promise<string>;
}

export function registerPeerSendTool(pi: ExtensionHostLike, deps: PeerSendDeps): void {
  pi.registerTool({
    name: 'peer_send',
    label: 'Peer Send',
    description:
      'Send a message to another live peer instance by name (see `/peers`). Only use when the user explicitly asks for cross-instance contact, or to reply to an inbound peer message — never use peers as subagents on your own. It is delivered as a real prompt: it steers the peer mid-turn or wakes it if idle. Fire-and-forget — the peer\'s reply arrives as a separate peer message.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name, as listed by `/peers`' },
        message: { type: 'string', description: 'Message body' },
        replyTo: { type: 'string', description: 'Message id being answered' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      try {
        const to = typeof params['to'] === 'string' ? (params['to'] as string) : '';
        const message = typeof params['message'] === 'string' ? (params['message'] as string) : '';
        const replyTo = typeof params['replyTo'] === 'string' ? (params['replyTo'] as string) : undefined;
        return { content: [{ type: 'text', text: await deps.send(to, message, replyTo) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `peer_send failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });
}

export interface PeerStatusDeps {
  listPeers: () => Promise<PeerRecord[]>;
  now?: () => number;
}

export function registerPeerStatusTool(pi: ExtensionHostLike, deps: PeerStatusDeps): void {
  pi.registerTool({
    name: 'peer_status',
    label: 'Peer Status',
    description:
      'Check what another live peer is doing: busy/idle, current activity, todos, and last heartbeat age. `to` is the peer name from `/peers`.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name, as listed by `/peers`' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      try {
        const to = typeof params['to'] === 'string' ? (params['to'] as string) : '';
        if (to === '') return { content: [{ type: 'text', text: 'Peer name (`to`) is required.' }] };
        const peers = await deps.listPeers();
        const peer = peers.find((p) => p.name === to);
        if (peer === undefined) {
          return { content: [{ type: 'text', text: `No live peer named "${to}". Use /peers to see who is live.` }] };
        }
        const now = deps.now?.() ?? Date.now();
        const lines = [
          `\`${peer.name}\` is ${peer.busy ? 'working' : 'idle'} in ${peer.cwd} · beat ${formatBeatAge(peer.beatAt, now)}.`,
          `Activity: ${peer.activity ?? '—'}`,
        ];
        if (peer.todos !== undefined && peer.todos.length > 0) {
          lines.push(`Todos (${peer.todos.length}):`);
          for (const todo of peer.todos) {
            const box = todo.status === 'done' ? '[x]' : todo.status === 'doing' ? '[-]' : '[ ]';
            lines.push(`- ${box} ${todo.text}`);
          }
        } else {
          lines.push('Todos: none');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `peer_status failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  });
}

export interface PeerTodoDeps {
  get: () => { name: string; activity?: string; todos: PeerTodo[] } | undefined;
  set: (opts: { activity?: string; todos?: PeerTodo[] }) => void;
  tick: () => Promise<void> | void;
}

const MAX_ACTIVITY_CHARS = 200;
const MAX_TODOS = 20;
const MAX_TODO_TEXT_CHARS = 200;

function clampString(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : '';
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeTodos(raw: unknown): PeerTodo[] {
  if (!Array.isArray(raw)) return [];
  const out: PeerTodo[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ text: clampString(item, MAX_TODO_TEXT_CHARS), status: 'pending' });
      continue;
    }
    if (typeof item === 'object' && item !== null && 'text' in item) {
      const t = item as Record<string, unknown>;
      const id = typeof t['id'] === 'string' ? t['id'] : undefined;
      const text = clampString(t['text'], MAX_TODO_TEXT_CHARS);
      const status =
        t['status'] === 'pending' || t['status'] === 'doing' || t['status'] === 'done'
          ? (t['status'] as 'pending' | 'doing' | 'done')
          : undefined;
      if (text !== '') out.push({ ...(id !== undefined ? { id } : {}), text, status });
    }
  }
  return out.slice(0, MAX_TODOS);
}

export function registerPeerTodoTool(pi: ExtensionHostLike, deps: PeerTodoDeps): void {
  pi.registerTool({
    name: 'peer_todo',
    label: 'Peer Todo',
    description:
      'Publish or update your own activity and todo list so other peers can see it. `action` is `set` (replace), `add` (append), or `clear` (remove all). `activity` is a short string; `todos` is an array of strings or `{text, status?}` objects. Values are clamped (200 chars for activity and each todo, 20 todos max).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'add', 'clear'], description: 'Whether to set, append, or clear the todo list' },
        activity: { type: 'string', description: 'Short activity description' },
        todos: {
          type: 'array',
          description: 'Todo items to set or add',
          items: {
            oneOf: [
              { type: 'string', description: 'Todo text (defaults to pending)' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'doing', 'done'] },
                },
                required: ['text'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      try {
        const action = typeof params['action'] === 'string' ? (params['action'] as string) : '';
        if (action !== 'set' && action !== 'add' && action !== 'clear') {
          return { content: [{ type: 'text', text: 'action must be set, add, or clear.' }] };
        }
        const state = deps.get();
        if (state === undefined) return { content: [{ type: 'text', text: 'peers not started.' }] };

        const setOpts: { activity?: string; todos?: PeerTodo[] } = {};

        if ('activity' in params) {
          const raw = params['activity'];
          const s = typeof raw === 'string' ? raw.trim() : '';
          setOpts.activity = s === '' ? undefined : clampString(s, MAX_ACTIVITY_CHARS);
        }

        if (action === 'clear') {
          setOpts.todos = [];
        } else if ('todos' in params) {
          const incoming = normalizeTodos(params['todos']);
          if (action === 'add') {
            setOpts.todos = [...state.todos, ...incoming].slice(0, MAX_TODOS);
          } else {
            setOpts.todos = incoming;
          }
        }

        deps.set(setOpts);
        await deps.tick();

        const updated = deps.get();
        const summary = `peer_todo: ${updated?.name ?? state.name} · ${updated?.activity ? `activity "${updated.activity}"` : 'no activity'} · ${updated?.todos?.length ?? 0} todo${(updated?.todos?.length ?? 0) === 1 ? '' : 's'}.`;
        return { content: [{ type: 'text', text: summary }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `peer_todo failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  });
}

export interface PeerRequestDeps {
  ownName: () => string;
  getHop: () => number;
  send: (to: string, message: string, deps: OutboundDeps) => Promise<string>;
  listPeers: () => Promise<PeerRecord[]>;
  getPendingReplies: () => Map<string, PendingReply> | undefined;
  getNow?: () => number;
}

async function statusHintFor(to: string, listPeers: () => Promise<PeerRecord[]>, now: number): Promise<string> {
  try {
    const peers = await listPeers();
    const peer = peers.find((p) => p.name === to);
    if (peer === undefined) return `No live peer named "${to}". Use /peers to see who is live.`;
    return `\`${peer.name}\` is ${peer.busy ? 'working' : 'idle'} · ${peer.activity ?? 'no activity'} · ${peer.todos?.length ?? 0} todos · beat ${formatBeatAge(peer.beatAt, now)}.`;
  } catch {
    return 'Use peer_status for details.';
  }
}

export function registerPeerRequestTool(pi: ExtensionHostLike, deps: PeerRequestDeps): void {
  pi.registerTool({
    name: 'peer_request',
    label: 'Peer Request',
    description:
      'Send a message to another live peer and wait for a matching reply with a timeout. `to` is the peer name, `message` the body. `timeout_ms` defaults to 30000 and is clamped between 5000 and 120000. `replyTo` is an optional correlation id; one is generated if omitted. The tool returns the reply body or a timeout message with a peer_status hint.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name, as listed by `/peers`' },
        message: { type: 'string', description: 'Message body' },
        timeout_ms: { type: 'number', description: 'Reply timeout in milliseconds (5000–120000, default 30000)' },
        replyTo: { type: 'string', description: 'Optional correlation id; generated if omitted' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const to = typeof params['to'] === 'string' ? (params['to'] as string) : '';
      const message = typeof params['message'] === 'string' ? (params['message'] as string) : '';
      if (to === '' || message === '') {
        return { content: [{ type: 'text', text: 'Both `to` and `message` are required.' }] };
      }

      let timeoutMs = 30_000;
      if ('timeout_ms' in params) {
        const n = Number(params['timeout_ms']);
        if (Number.isFinite(n)) {
          timeoutMs = Math.max(5_000, Math.min(120_000, Math.trunc(n)));
        }
      }

      const replyTo =
        typeof params['replyTo'] === 'string' && (params['replyTo'] as string) !== ''
          ? (params['replyTo'] as string)
          : randomUUID();

      const pending = deps.getPendingReplies();
      if (pending === undefined) {
        return { content: [{ type: 'text', text: 'peers not started.' }] };
      }

      let resolve!: (body: string) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.set(replyTo, { resolve, reject });

      try {
        const receipt = await deps.send(to, message, {
          ownName: deps.ownName(),
          hop: deps.getHop(),
          listPeers: deps.listPeers,
          replyTo,
        });

        const queueable =
          receipt.startsWith('Delivered to') ||
          receipt.startsWith('Held at') ||
          receipt.startsWith('Queued at');

        if (!queueable) {
          // Not a queueable delivery — e.g. unknown peer, refused, or it
          // matched a pending request on the far end and was consumed.
          pending.delete(replyTo);
          reject(new Error('not delivered'));
          return { content: [{ type: 'text', text: receipt }] };
        }

        if (!pending.has(replyTo)) {
          // A very fast reply already arrived and resolved before sendToPeer
          // returned; the promise is already resolved.
          const body = await promise;
          return { content: [{ type: 'text', text: `Reply from ${to}: ${body}` }] };
        }

        const entry = pending.get(replyTo)!;
        entry.timer = setTimeout(() => {
          if (pending.has(replyTo)) {
            pending.delete(replyTo);
            reject(new Error('timeout'));
          }
        }, timeoutMs);

        const body = await promise;
        return { content: [{ type: 'text', text: `Reply from ${to}: ${body}` }] };
      } catch (err) {
        pending.delete(replyTo);
        if (err instanceof Error && err.message === 'timeout') {
          const now = deps.getNow?.() ?? Date.now();
          const hint = await statusHintFor(to, deps.listPeers, now);
          return { content: [{ type: 'text', text: `Request to ${to} timed out after ${timeoutMs}ms. ${hint}` }] };
        }
        return { content: [{ type: 'text', text: `peer_request failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  });
}
