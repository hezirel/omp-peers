/**
 * Peers acceptance test — runs against the COMPILED package (dist) with
 * OMP_PEERS_DIR pointed at a fresh temp dir.
 *
 * Covers: presence beat → roster lists both fake peers; outbound socket frame
 * → inbound path with a FAKE pi capturing `sendUserMessage` calls — attributed
 * `[peer <name>]` text delivered with default options (never a hardcoded
 * driving-agent name, no registry lookup); over-budget wakes queue as asides;
 * bridgeless hosts still deliver (as an aside); empty frames and missing
 * contexts drop without touching the host; hop-cap refusal; burst coalescing;
 * session-name adoption (`peerNameFromSession`) + first-wins collision;
 * stale reap.
 *
 * Plain Node ESM — no test-runner dependency (also runs under `node --test`).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.OMP_PEERS_DIR = await mkdtemp(join(tmpdir(), 'peers-test-'));
const STATE = process.env.OMP_PEERS_DIR;

const {
  writePeerBeat,
  listLivePeers,
  removePeerRecord,
  peerNameFromSession,
  buildPeersNote,
  appendNoteToMessages,
  deliverInboundPeerMessage,
  formatPeerText,
  isWakeOverBudget,
  recordPeerWake,
  sendToPeer,
  validatePeerName,
  resolvePeerName,
  defaultPeerName,
  peerSocketAddress,
  startPeerServer,
  requestPeer,
  formatPeersText,
  peerPath,
  PEER_TTL_MS,
  registerPeerSendTool,
} = await import('../dist/index.js');

const ALIVE = () => true;

function fakeCtx(sessionId, { idle = true } = {}) {
  const sent = [];
  const noted = [];
  return {
    ctx: {
      cwd: join(STATE, 'work'),
      mode: 'tui',
      ui: {
        notify: (message, type) => noted.push({ message, type }),
      },
      sessionManager: { getSessionId: () => sessionId },
      model: { id: 'test-model' },
      isIdle: () => idle,
    },
    pi: {
      sendUserMessage: (text, opts) => sent.push({ text, opts }),
    },
    sent,
    noted,
  };
}

describe('presence beat → roster lists both peers', () => {
  it('beats two fake peers and lists both live', async () => {
    await writePeerBeat({
      stateDir: STATE, pid: 47111, name: 'alpha', cwd: join(STATE, 'a'),
      harness: 'omp', sessionId: 'sess-a', model: 'm1',
      socket: peerSocketAddress(STATE, 47111), startedAt: 1000, busy: false,
    });
    await writePeerBeat({
      stateDir: STATE, pid: 47222, name: 'beta', cwd: join(STATE, 'b'),
      harness: 'pi', sessionId: 'sess-b', model: 'm2',
      socket: peerSocketAddress(STATE, 47222), startedAt: 2000, busy: true,
    });
    const live = await listLivePeers(STATE, 47111, { isAlive: ALIVE });
    assert.equal(live.length, 2);
    assert.deepEqual(live.map((p) => p.name), ['alpha', 'beta']);
    const note = buildPeersNote('alpha', live, 'tools');
    assert.match(note, /`alpha`/);
    assert.match(note, /`beta`/);
    assert.match(note, /peer_send/);
    const hubNote = buildPeersNote('alpha', live, 'hub');
    assert.match(hubNote, /`hub`/);
  });

  it('reaps dead pids and expired beats on sight', async () => {
    const live = await listLivePeers(STATE, 47111, { isAlive: ALIVE });
    assert.equal(live.length, 2);
    // Dead pid (liveness seam reports it gone) is unlinked.
    await writePeerBeat({
      stateDir: STATE, pid: 2147483647, name: 'ghost', cwd: join(STATE, 'g'),
      harness: 'pi', socket: peerSocketAddress(STATE, 2147483647), startedAt: 1,
    });
    // Expired beat with a "live" pid is unlinked by TTL.
    const stalePath = peerPath(47999, STATE);
    await writeFile(
      stalePath,
      JSON.stringify({
        v: 1, pid: 47999, name: 'stale', cwd: join(STATE, 's'), project: 's',
        harness: 'omp', sessionId: '', model: '', socket: peerSocketAddress(STATE, 47999),
        startedAt: 1, beatAt: Date.now() - PEER_TTL_MS - 1000, busy: false,
      }) + '\n'
    );
    const after = await listLivePeers(STATE, 47111, {
      isAlive: (pid) => pid !== 2147483647,
    });
    assert.deepEqual(after.map((p) => p.name), ['alpha', 'beta']);
  });

  it('compacts the roster note when no peers are live', () => {
    const solo = buildPeersNote('alpha', [], 'tools');
    assert.match(solo, /`alpha`/);
    assert.match(solo, /No other peers are live/);
    assert.doesNotMatch(solo, /peer_send/);
  });

  it('formats the /peers text columns', () => {
    const now = Date.now();
    const text = formatPeersText(
      {
        ownName: 'alpha',
        mode: 'hub',
        peers: [
          {
            v: 1, pid: 47111, name: 'alpha', cwd: '/w/a', project: 'a', harness: 'omp',
            sessionId: 's', model: 'm1', socket: 'x', startedAt: 1, beatAt: now - 3000, busy: true,
          },
        ],
      },
      now
    );
    assert.match(text, /alpha · omp\(47111\) · \/w\/a · m1 · working · beat 3s ago · you/);
  });

  it('appends the roster note to the last user message', () => {
    const messages = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'do it' },
    ];
    appendNoteToMessages(messages, 'NOTE');
    assert.equal(messages[1].content, 'do it\n\nNOTE');
    const empty = appendNoteToMessages([], 'NOTE');
    assert.deepEqual(empty, [{ role: 'user', content: 'NOTE' }]);
  });
});

describe('outbound frame → inbound path', () => {
  const addrB = peerSocketAddress(STATE, 47333);
  let seen = [];
  let deliveries = 0;
  let server;
  before(async () => {
    server = startPeerServer({
      address: addrB,
      ownName: () => 'beta',
      onMessage: async (msg) => {
        deliveries += 1;
        seen.push(msg);
        return 'injected';
      },
    });
    // Named pipes (win32) bind asynchronously; unix sockets too — wait for it.
    await new Promise((r) => setTimeout(r, 500));
  });

  it('delivers a socket frame with a text receipt', async () => {
    const recordB = {
      v: 1, pid: 47333, name: 'beta', cwd: '/w/b', project: 'b', harness: 'pi',
      sessionId: '', model: '', socket: addrB, startedAt: 1, beatAt: Date.now(), busy: false,
    };
    const receipt = await sendToPeer('beta', 'hello from alpha', {
      ownName: 'alpha',
      hop: 0,
      listPeers: async () => [recordB],
    });
    assert.match(receipt, /^Delivered to beta \(injected\)/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].from, 'alpha');
    assert.equal(seen[0].body, 'hello from alpha');
    assert.equal(seen[0].hop, 0);
  });

  it('refuses unknown peers, broadcasts, and self-sends without throwing', async () => {
    const deps = { ownName: 'alpha', listPeers: async () => [] };
    assert.match(await sendToPeer('nobody', 'hi', deps), /Unknown peer "nobody"/);
    assert.match(await sendToPeer('all', 'hi', deps), /Broadcasts are not supported/);
    assert.match(await sendToPeer('alpha', 'hi', deps), /yourself/);
    assert.match(await sendToPeer('', '', deps), /required/);
  });

  it('answers ping and refuses over-hop frames', async () => {
    const pong = await requestPeer(addrB, { t: 'ping', from: 'alpha' });
    assert.equal(pong?.ok, true);
    assert.equal(pong?.name, 'beta');
    const refused = await requestPeer(addrB, { t: 'msg', from: 'alpha', body: 'far', hop: 99 });
    assert.equal(refused?.ok, false);
    assert.match(refused?.error ?? '', /limit is 4/);
  });

  it('coalesces a burst from one sender into a single wake', async () => {
    deliveries = 0;
    const p1 = requestPeer(addrB, { t: 'msg', from: 'burst', body: 'one', hop: 0 });
    const p2 = requestPeer(addrB, { t: 'msg', from: 'burst', body: 'two', hop: 0 });
    const [r1, r2] = await Promise.all([p1, p2]);
    const outcomes = [r1?.outcome, r2?.outcome].sort();
    assert.deepEqual(outcomes, ['coalesced', 'injected']);
    assert.equal(deliveries, 1);
  });

  it('drops oversized frames without delivering', async () => {
    const before = deliveries;
    const res = await requestPeer(addrB, { t: 'msg', from: 'big', body: 'x'.repeat(2_000_000), hop: 0 });
    assert.equal(res?.ok, false);
    assert.match(res?.error ?? '', /too large/);
    assert.equal(deliveries, before);
  });

  it('stops the server', () => {
    server.stop();
  });
});

describe('inbound delivery against a fake host', () => {
  const live = (opts) => {
    const cur = fakeCtx('sess-beta', opts);
    return { cur, deps: { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) } };
  };

  it('delivers attributed text through sendUserMessage with default options', async () => {
    const { cur, deps } = live();
    const res = await deliverInboundPeerMessage({ from: 'alpha', body: 'hello' }, deps);
    assert.equal(res.outcome, 'woken');
    assert.equal(cur.sent.length, 1);
    assert.match(cur.sent[0].text, /^\[peer alpha\]/);
    assert.match(cur.sent[0].text, /hello/);
    assert.match(cur.sent[0].text, /peer_send/);
    assert.match(cur.sent[0].text, /not your user/);
    assert.equal(cur.sent[0].opts, undefined);
    assert.equal(/Main/.test(cur.sent[0].text), false);
  });

  it('steers a busy host mid-turn without spending wake budget', async () => {
    const cur = fakeCtx('sess-beta', { idle: false });
    const wakes = new Map();
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'hello' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes }
    );
    assert.equal(res.outcome, 'injected');
    assert.equal(cur.sent.length, 1);
    assert.equal(cur.sent[0].opts, undefined);
    assert.equal(wakes.has('alpha'), false);
  });

  it('drops empty frames and missing contexts without touching the host', async () => {
    const cur = fakeCtx('sess-beta');
    const deps = { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) };
    assert.equal((await deliverInboundPeerMessage({ from: '', body: 'hi' }, deps)).outcome, 'dropped');
    assert.equal((await deliverInboundPeerMessage({ from: 'alpha', body: '' }, deps)).outcome, 'dropped');
    assert.equal(
      (await deliverInboundPeerMessage({ from: 'alpha', body: 'hi' }, { ...deps, getCurrent: () => undefined })).outcome,
      'dropped'
    );
    assert.equal(cur.sent.length, 0);
  });

  it('queues over-budget wakes as asides on the current pi', async () => {
    const cur = fakeCtx('sess-beta');
    const now = Date.now();
    const wakes = new Map([['alpha', Array.from({ length: 20 }, (_, i) => now - i * 1000)]]);
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'again' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes, now: () => now }
    );
    assert.equal(res.outcome, 'aside');
    assert.equal(cur.sent.length, 1);
    assert.match(cur.sent[0].text, /^\[peer alpha\]/);
    assert.equal(cur.sent[0].opts?.deliverAs, 'aside');
  });

  it('delivers on bridgeless hosts through sendUserMessage (no aside fallback)', async () => {
    const cur = fakeCtx('sess-beta');
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'plain' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) }
    );
    assert.equal(res.outcome, 'woken');
    assert.equal(cur.sent.length, 1);
    assert.match(cur.sent[0].text, /^\[peer alpha\]/);
    assert.match(cur.sent[0].text, /peer_send/);
    assert.equal(cur.sent[0].opts, undefined);
  });

  it('never throws when the host send fails', async () => {
    const cur = fakeCtx('sess-beta');
    cur.pi.sendUserMessage = () => {
      throw new Error('host busy');
    };
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'boom' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) }
    );
    assert.equal(res.outcome, 'dropped');
    assert.match(res.detail ?? '', /host busy/);
    assert.equal(cur.noted.length, 1);
  });

  it('records idle deliveries against the hourly wake budget', async () => {
    const wakes = new Map();
    const cur = fakeCtx('sess-beta');
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'wake up' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes }
    );
    assert.equal(res.outcome, 'woken');
    assert.equal((wakes.get('alpha') ?? []).length, 1);
    assert.equal(isWakeOverBudget(wakes, 'alpha', Date.now(), 1), true);
    assert.equal(isWakeOverBudget(wakes, 'alpha', Date.now(), 2), false);
    recordPeerWake(wakes, 'alpha', Date.now());
    assert.equal((wakes.get('alpha') ?? []).length, 2);
  });

  it('prefixes every injection, names the peer as not-the-user, and points replies at peer_send', () => {
    // The hint must never offer `hub` op=send: the probe may hold a foreign
    // registry copy where hub cannot resolve peer names.
    assert.match(formatPeerText('a', 'b'), /^\[peer a\]/);
    assert.match(formatPeerText('a', 'b'), /from peer `a`.*not your user/);
    assert.match(formatPeerText('a', 'b'), /Reply with `peer_send` to="a"/);
    assert.doesNotMatch(formatPeerText('a', 'b'), /`hub`/);
  });
});

describe('peer identity: validation, collision, session-name adoption', () => {
  it('accepts valid names and rejects the rest', () => {
    validatePeerName('backend');
    validatePeerName('a.b-c_d9');
    assert.throws(() => validatePeerName(''), /invalid peer name/);
    assert.throws(() => validatePeerName('has space'), /invalid peer name/);
    assert.throws(() => validatePeerName('Main'), /driving agent/);
    assert.throws(() => validatePeerName('x'.repeat(25)), /invalid peer name/);
    assert.throws(() => validatePeerName('agent-1', { localIds: ['agent-1'] }), /live local subagent/);
    // Case-sensitive: only the exact host name is refused.
    validatePeerName('main');
  });

  it('resolves cross-process collisions first-wins by startedAt', () => {
    const older = { v: 1, pid: 100, name: 'backend', cwd: '/', project: 'x', harness: 'omp', sessionId: '', model: '', socket: '', startedAt: 1000, beatAt: 1000, busy: false };
    assert.equal(
      resolvePeerName({ candidate: 'backend', pid: 200, startedAt: 2000, peers: [older] }),
      'backend-200'
    );
    assert.equal(
      resolvePeerName({ candidate: 'backend', pid: 100, startedAt: 1000, peers: [{ ...older, pid: 200, startedAt: 2000, name: 'backend' }] }),
      'backend'
    );
    assert.equal(resolvePeerName({ candidate: 'solo', pid: 300, startedAt: 3000, peers: [older] }), 'solo');
  });

  it('defaults to a valid basename-pid address', () => {
    assert.match(defaultPeerName('/work/my proj', 123), /^[A-Za-z0-9_.-]{1,24}$/);
  });

  it('adopts a raw valid session name and falls back otherwise', () => {
    assert.deepEqual(peerNameFromSession('backend', '/work/proj', 5), { name: 'backend' });
    const rejected = peerNameFromSession('My Agent', '/work/proj', 5);
    assert.equal(rejected.rejected, 'My Agent');
    assert.equal(rejected.name, defaultPeerName('/work/proj', 5));
    assert.deepEqual(peerNameFromSession('', '/work/proj', 5), {
      name: defaultPeerName('/work/proj', 5),
    });
    assert.deepEqual(peerNameFromSession(undefined, '/work/proj', 5), {
      name: defaultPeerName('/work/proj', 5),
    });
  });
});

describe('peer name follows the host session name (tick level)', () => {
  const handlers = {};
  const noted = [];
  const logged = [];
  let sessionName;
  let sessionId = 'sess-tick-1';
  const fakePi = {
    registerCommand: () => {},
    registerTool: () => {},
    on: (event, handler) => { handlers[event] = handler; },
    logger: { warn: (message) => logged.push(message), info: () => {}, error: () => {} },
    getSessionName: () => sessionName,
  };
  const fakeCtx = {
    cwd: join(STATE, 'tickproj'),
    ui: { notify: (message, type) => noted.push({ message, type }) },
    sessionManager: { getSessionId: () => sessionId },
  };

  async function waitForOwnBeat(expectedName) {
    for (let i = 0; i < 100; i += 1) {
      const live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
      const rec = live.find((p) => p.pid === process.pid);
      if (rec !== undefined && rec.name === expectedName) return rec;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`own beat never reached name "${expectedName}"`);
  }

  it('beats under the session name; warns once per process', async () => {
    const peersExtension = (await import('../dist/extension.js')).default;
    peersExtension(fakePi);

    sessionName = 'test-peer';
    handlers['session_start'](undefined, fakeCtx);
    const adopted = await waitForOwnBeat('test-peer');
    assert.equal(adopted.name, 'test-peer');

    sessionName = 'Fix the login bug later';
    sessionId = 'sess-tick-2';
    handlers['session_switch'](undefined, fakeCtx);
    const fallback = defaultPeerName(join(STATE, 'tickproj'), process.pid);
    const rejectedBeat = await waitForOwnBeat(fallback);
    assert.equal(rejectedBeat.name, fallback);
    assert.equal(noted.length, 1);
    assert.match(noted[0].message, /Fix the login bug later/);
    assert.match(noted[0].message, /\/rename/);

    sessionId = 'sess-tick-3';
    handlers['session_switch'](undefined, fakeCtx);
    await waitForOwnBeat(fallback);
    assert.equal(noted.length, 1, 'no repeat notify for the same rejected name');
    sessionName = 'Add deepseek-harness retro checks';
    sessionId = 'sess-tick-4';
    handlers['session_switch'](undefined, fakeCtx);
    for (let i = 0; i < 100 && !logged.some((m) => m.includes('Add deepseek-harness retro checks')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(logged.some((m) => m.includes('Add deepseek-harness retro checks')), 'second rejection logs instead of popping up');
    assert.equal(noted.length, 1, 'no second popup for a new auto-title; later ones log only');

    handlers['session_shutdown']();
  });
});

describe('peer_send registration is mode-independent', () => {
  function fakePi(sendImpl) {
    const tools = {};
    return {
      pi: { registerTool: (def) => { tools[def.name] = def; } },
      tools,
      sendImpl,
    };
  }
  for (const mode of ['hub', 'tools']) {
    it(`registers peer_send in ${mode} mode`, async () => {
      const { pi, tools } = fakePi(async () => 'ok');
      registerPeerSendTool(pi, { send: async (to, message) => `sent:${to}:${message}` });
      assert.ok(tools['peer_send'], `peer_send registered in ${mode} mode`);
      assert.deepEqual(tools['peer_send'].parameters.required, ['to', 'message']);
    });
  }
  it('execute delegates to send and surfaces failures as text', async () => {
    const { tools } = fakePi(async () => 'ok');
    registerPeerSendTool(
      { registerTool: (def) => { tools[def.name] = def; } },
      { send: async (to, message, replyTo) => `sent:${to}:${message}:${replyTo ?? '-'}` }
    );
    const ok = await tools['peer_send'].execute('id-1', { to: 'beta', message: 'hi' });
    assert.match(ok.content[0].text, /^sent:beta:hi:-$/);
    registerPeerSendTool(
      { registerTool: (def) => { tools[def.name] = def; } },
      { send: async () => { throw new Error('no route'); } }
    );
    const failed = await tools['peer_send'].execute('id-2', { to: 'beta', message: 'hi' });
    assert.match(failed.content[0].text, /peer_send failed: no route/);
  });
});

describe('shutdown unlink', () => {
  it('removes the own presence record', async () => {
    await writePeerBeat({
      stateDir: STATE, pid: 47777, name: 'tmp', cwd: join(STATE, 't'),
      harness: 'pi', socket: peerSocketAddress(STATE, 47777), startedAt: 1,
    });
    let live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
    assert.ok(live.some((p) => p.name === 'tmp'));
    await removePeerRecord(STATE, 47777);
    live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
    assert.ok(!live.some((p) => p.name === 'tmp'));
  });
});

after(async () => {
  await rm(STATE, { recursive: true, force: true });
});
