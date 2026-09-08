/**
 * Agent tool surface: exactly ONE tool, `peer_send`.
 *
 * Registered UNCONDITIONALLY in every mode: on omp hosts the bridge carries
 * peers as native `hub` refs, but those are best-effort (the bridge may bind
 * a foreign registry copy on compiled hosts), so `peer_send {to, message,
 * replyTo?}` is THE guaranteed agent path everywhere. Explicit names only —
 * `to:"all"` is refused.
 */
export function registerPeerSendTool(pi, deps) {
    pi.registerTool({
        name: 'peer_send',
        label: 'Peer Send',
        description: 'Send a message to another live peer instance by name (see `/peers`). It is delivered as a real prompt: it steers the peer mid-turn or wakes it if idle. Fire-and-forget — the peer\'s reply arrives as a separate peer message.',
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
                const to = typeof params['to'] === 'string' ? params['to'] : '';
                const message = typeof params['message'] === 'string' ? params['message'] : '';
                const replyTo = typeof params['replyTo'] === 'string' ? params['replyTo'] : undefined;
                return { content: [{ type: 'text', text: await deps.send(to, message, replyTo) }] };
            }
            catch (err) {
                return {
                    content: [{ type: 'text', text: `peer_send failed: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    });
}
