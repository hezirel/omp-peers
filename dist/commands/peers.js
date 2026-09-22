/**
 * `/peers` — list live instances: name · harness(pid) · cwd · model ·
 * busy/idle · beat age. Text list always; the interactive picker runs ONLY
 * when `typeof ctx.ui?.select === 'function' && ctx.mode === 'tui'`, else
 * plain text. No UI module is ever imported — the primitive is probed on the
 * live ctx and invoked as a receiver method.
 */
import { displayTitle } from '../peers/roster.js';
import { formatBeatAge } from '../peers/presence.js';
/** `backend · omp(1234) · C:\work · model-id · working · beat 3s ago`. */
export function formatPeerLine(p, now, selfName) {
    const self = p.name === selfName ? ' · you' : '';
    const title = displayTitle(p);
    const activity = p.activity ? ` · ${p.activity}` : '';
    const todos = p.todos?.length
        ? ` · ${p.todos.length} todo${p.todos.length === 1 ? '' : 's'}`
        : '';
    return `${p.name}${title} · ${p.harness}(${p.pid}) · ${p.cwd} · ${p.model === '' ? '—' : p.model} · ${p.busy ? 'working' : 'idle'} · beat ${formatBeatAge(p.beatAt, now)}${activity}${todos}${self}`;
}
export function formatPeersText(snap, now) {
    const lines = [...snap.peers]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => formatPeerLine(p, now, snap.ownName));
    const hidden = (snap.hidden ?? 0) > 0 ? ` · ${snap.hidden} other-project hidden (/peers scope all)` : '';
    const header = `peers (${snap.peers.length}) — you are \`${snap.ownName}\` via ${snap.mode === 'hub' ? 'hub bridge' : 'peer tools'}${(snap.held ?? 0) > 0 ? ` · held ${snap.held}` : ''}${hidden}`;
    return lines.length === 0 ? `${header} — no same-project peers` : `${header}\n${lines.join('\n')}`;
}
export function registerPeersCommand(pi, getSnapshot, setScope) {
    pi.registerCommand('peers', {
        description: 'List live peer instances on this machine; `peers scope cwd|all` toggles the view scope',
        handler: async (_args, ctx) => {
            try {
                const parts = (_args ?? '').trim().split(/\s+/).filter(Boolean);
                if (parts[0] === 'scope') {
                    const value = parts[1];
                    if (value !== 'cwd' && value !== 'all') {
                        const snap = await getSnapshot();
                        ctx.ui?.notify(`peer scope: ${snap.scope ?? 'cwd'} — /peers scope cwd|all`, 'info');
                        return;
                    }
                    if (setScope === undefined) {
                        ctx.ui?.notify('peer scope: not available in this host', 'warning');
                        return;
                    }
                    setScope(value);
                    const snap = await getSnapshot();
                    ctx.ui?.notify(`peer scope → ${value} (${snap.peers.length} visible, ${snap.hidden ?? 0} hidden)`, 'info');
                    return;
                }
                const snap = await getSnapshot();
                const select = ctx.ui?.select;
                if (typeof select === 'function' && ctx.mode === 'tui' && snap.peers.length > 0) {
                    try {
                        const picked = await select.call(ctx.ui, 'Peers — pick one for details', [...snap.peers]
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((p) => ({
                            label: p.name,
                            description: `${displayTitle(p).trim() ? `${displayTitle(p).trim()} · ` : ''}${p.harness}(${p.pid}) · ${p.cwd}${p.busy ? ' · working' : ''}${p.activity ? ` · ${p.activity}` : ''}`,
                        })));
                        if (typeof picked === 'string' && picked !== '') {
                            const peer = snap.peers.find((p) => p.name === picked);
                            ctx.ui.notify(peer !== undefined ? formatPeerLine(peer, Date.now(), snap.ownName) : formatPeersText(snap, Date.now()), 'info');
                        }
                        return;
                    }
                    catch {
                        // Picker failed — fall through to the text list.
                    }
                }
                ctx.ui.notify(formatPeersText(snap, Date.now()), 'info');
            }
            catch (err) {
                try {
                    ctx.ui.notify(`/peers failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
                }
                catch {
                    // Notify is best-effort.
                }
            }
        },
    });
}
