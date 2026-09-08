/**
 * Error classes thrown by the peers extension.
 *
 * The class `name` doubles as a stable code the OMP wiring can branch on
 * (all names are unique and never minified away). `instanceof` also works.
 */
export declare class LockError extends Error {
    constructor(message: string);
}
export declare class CorruptStateError extends Error {
    constructor(message: string);
}
export declare class PeerNameError extends Error {
    constructor(message: string);
}
export declare class PeerNotFoundError extends Error {
    constructor(message: string);
}
