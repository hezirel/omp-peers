/**
 * peers — opt-in live peer awareness for OMP/pi agent instances.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat. Library entry (storage + presence +
 * transport + delivery); the extension entry is `./extension.js`.
 */
// Store layer.
export { resolveStateDir, ensureStateDirs, peersDir, peerPath, } from './store/paths.js';
export { withRegistryLock, mkdirLock, unlockDir, durableWriteJson, appendJsonl, readJsonFile, readJsonlRecords, countJsonlLines, LOCK_STALE_MS, LOCK_TIMEOUT_MS, JSON_RETRY_DELAY_MS, } from './store/atomic.js';
// Peer identity.
export { PEER_NAME_PATTERN, isValidPeerName, validatePeerName, defaultPeerName, peerNameFromSession, resolvePeerName, } from './peers/ids.js';
// Presence.
export { writePeerBeat, listLivePeers, removePeerRecord, startPresenceBeat, formatBeatAge, HEARTBEAT_MS, PEER_TTL_MS, } from './peers/presence.js';
// Transport.
export { MAX_HOPS, COALESCE_MS, PEER_REQUEST_TIMEOUT_MS, peerSocketAddress, startPeerServer, requestPeer, } from './peers/server.js';
// Delivery.
export { deliverInboundPeerMessage, formatPeerText, isWakeOverBudget, recordPeerWake, MAX_WAKES_PER_PEER_PER_HOUR, WAKE_WINDOW_MS, } from './peers/inbound.js';
export { sendToPeer } from './peers/outbound.js';
// Roster.
export { buildPeersNote, appendNoteToMessages, } from './peers/roster.js';
// Host seam.
export { probeHost, discoverOwnAgentId, listLocalAgentIds, claimBridgedPeer, releaseBridgedPeer, peerActivityFor, SETTINGS_STUB, } from './peers/host.js';
// Commands (pure text formatters for tests/consumers).
export { formatPeersText, formatPeerLine } from './commands/peers.js';
// Agent tool surface (registered unconditionally in every mode).
export { registerPeerSendTool } from './tools.js';
// Errors and shared schemas.
export * from './errors.js';
