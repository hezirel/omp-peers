/**
 * Roster — identity + peer list injected on the host `context` event.
 *
 * The event payload's messages are a provider-bound clone that never reaches
 * the transcript, so appending to the last user message keeps provider role
 * alternation and the cached prompt prefix intact (verified pattern from the
 * bridge reference). The note is always injected — even with no peers — so
 * the agent always knows its own peer name; rows degrade to a solo line.
 */
import type { PeerRecord } from '../types.js';
export type RosterMode = 'hub' | 'tools';
export interface RosterMessage {
    role: string;
    content: string | Array<{
        type: string;
        text?: string;
    }>;
}
/** Identity line + contact rule + peer definition + one row per peer (solo compacts to two lines). */
export declare function buildPeersNote(ownName: string, peers: PeerRecord[], mode: RosterMode): string;
/**
 * Fold `note` into the last user message (string content is suffixed, array
 * content is pushed) or append a fresh user message when none exists.
 * Mutates `messages` in place and returns it.
 */
export declare function appendNoteToMessages(messages: RosterMessage[], note: string): RosterMessage[];
