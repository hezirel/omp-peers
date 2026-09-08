/**
 * State-directory layout and path helpers.
 *
 * The state dir is machine-global and NEVER repo-local. Resolution order:
 *   1. `$OMP_PEERS_DIR` (explicit override)
 *   2. `%LOCALAPPDATA%\omp-peers`   (Windows)
 *   3. `$HOME/.omp/var/omp-peers`   (fallback)
 *
 * Layout:
 *   <state>/peers/<pid>.json      owner-only presence records (0600)
 *   <state>/peers/<pid>.sock      unix sockets (non-Windows only)
 */
/** Resolve the machine-global state dir from the environment. */
export declare function resolveStateDir(): string;
/** Directory holding one `<pid>.json` presence record per live peer. */
export declare function peersDir(stateDir?: string): string;
/** Presence record for one peer pid (single writer: the owning process). */
export declare function peerPath(pid: number, stateDir?: string): string;
/** Create the fixed state directory skeleton. Returns the state dir. */
export declare function ensureStateDirs(stateDir?: string): Promise<string>;
