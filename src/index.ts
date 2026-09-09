/**
 * peers — opt-in live peer awareness for OMP/pi agent instances.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat. Library entry (storage + presence +
 * transport + delivery); the extension entry is `./extension.js`.
 */

// Store layer.
export {
  resolveStateDir,
  ensureStateDirs,
  peersDir,
  peerPath,
} from './store/paths.js';
export {
  withRegistryLock,
  mkdirLock,
  unlockDir,
  durableWriteJson,
  appendJsonl,
  readJsonFile,
  readJsonlRecords,
  countJsonlLines,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  JSON_RETRY_DELAY_MS,
  type LockOptions,
  type TolerantReadOptions,
} from './store/atomic.js';

// Peer identity.
export {
  PEER_NAME_PATTERN,
  isValidPeerName,
  validatePeerName,
  defaultPeerName,
  peerNameFromSession,
  resolvePeerName,
  type ResolveNameInput,
} from './peers/ids.js';

// Presence.
export {
  writePeerBeat,
  listLivePeers,
  removePeerRecord,
  startPresenceBeat,
  formatBeatAge,
  HEARTBEAT_MS,
  PEER_TTL_MS,
  type BeatInput,
  type ListPeersOptions,
  type PresenceBeatOptions,
} from './peers/presence.js';

// Transport.
export {
  MAX_HOPS,
  COALESCE_MS,
  PEER_REQUEST_TIMEOUT_MS,
  SOCKET_IDLE_MS,
  MAX_FRAME_BYTES,
  peerSocketAddress,
  startPeerServer,
  requestPeer,
  type InboundMessage,
  type PeerServerOptions,
  type PeerServerHandle,
} from './peers/server.js';

// Delivery.
export {
  deliverInboundPeerMessage,
  formatPeerText,
  isWakeOverBudget,
  recordPeerWake,
  MAX_WAKES_PER_PEER_PER_HOUR,
  WAKE_WINDOW_MS,
  type InboundCarrier,
  type CurrentHost,
  type InboundOutcome,
  type InboundDeps,
} from './peers/inbound.js';
export { sendToPeer, type OutboundDeps } from './peers/outbound.js';

// Roster.
export {
  buildPeersNote,
  appendNoteToMessages,
  type RosterMode,
  type RosterMessage,
} from './peers/roster.js';

// Host seam.
export {
  probeHost,
  discoverOwnAgentId,
  listLocalAgentIds,
  claimBridgedPeer,
  releaseBridgedPeer,
  peerActivityFor,
  SETTINGS_STUB,
  type HostProbe,
  type HubBridge,
  type RegistryLike,
  type RegistryRefLike,
  type ExecuteSendFn,
  type PeerRequestFn,
  type CommandContextLike,
  type ExtensionHostLike,
  type UiLike,
  type SelectOption,
} from './peers/host.js';

// Commands (pure text formatters for tests/consumers).
export { formatPeersText, formatPeerLine, type PeersSnapshot } from './commands/peers.js';
// Agent tool surface (registered unconditionally in every mode).
export { registerPeerSendTool, type PeerSendDeps } from './tools.js';

// Errors and shared schemas.
export * from './errors.js';
export type {
  HarnessKind,
  PeerRecord,
  PeerFrame,
  PeerReply,
} from './types.js';
