/**
 * Roster — identity + peer list injected on the host `context` event.
 *
 * The event payload's messages are a provider-bound clone that never reaches
 * the transcript, so appending to the last user message keeps provider role
 * alternation and the cached prompt prefix intact (verified pattern from the
 * bridge reference). The note is always injected — even with no peers — so
 * the agent always knows its own peer name; rows degrade to a solo line.
 */
/** Identity line + addressing guide + one row per peer. */
export function buildPeersNote(ownName, peers, mode) {
    const rows = peers.length === 0
        ? '- (no other peers are live right now)'
        : [...peers]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((peer) => 
        // pid in every row: suffixed collision names (e.g. `test-peer`
        // vs `test-peer-22148`) must never be mistakable for self.
        `- \`${peer.name}\` — ${peer.harness}(${peer.pid}) instance in ${peer.cwd}${peer.busy ? ' (working)' : ' (idle)'}`)
            .join('\n');
    const guide = [
        'Peer names are session names — rename a session with the host\'s builtin `/rename <name>`.',
        'A session name is a valid peer address only in raw form: 1-24 of a-z A-Z 0-9 _ . - (no spaces);',
        'invalid names keep the default `<dir>-<pid>` address.',
        ...(mode === 'hub'
            ? [
                'They are addressable through the `peer_send` tool — that is the working agent path:',
                '`peer_send` to="<name>" injects a real prompt into that instance\'s agent, and its reply arrives here as a peer message.',
                'Native `hub` op=send to="<name>" is best-effort: it is visible only if the host resolves the bridged ref.',
            ]
            : [
                'They are addressable by name through the `peer_send` tool:',
                '`peer_send` to="<name>" injects a real prompt into that instance\'s agent, and its reply arrives here as a peer message.',
            ]),
    ];
    return [`<peers>`, `You are the agent instance with peer name \`${ownName}\`.`, ...guide, '', rows, `</peers>`].join('\n');
}
/**
 * Fold `note` into the last user message (string content is suffixed, array
 * content is pushed) or append a fresh user message when none exists.
 * Mutates `messages` in place and returns it.
 */
export function appendNoteToMessages(messages, note) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined || message.role !== 'user')
            continue;
        if (typeof message.content === 'string') {
            message.content = `${message.content}\n\n${note}`;
            return messages;
        }
        if (Array.isArray(message.content)) {
            message.content.push({ type: 'text', text: note });
            return messages;
        }
    }
    messages.push({ role: 'user', content: note });
    return messages;
}
