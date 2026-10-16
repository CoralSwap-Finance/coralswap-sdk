/**
 * Mappings for CoralSwap contract error codes to human-readable messages.
 *
 * These codes are defined in the Soroban contracts using #[contracterror].
 *
 * This module is the single source of truth for contract error code ranges.
 * Both {@link ErrorParser.parseContractError} and the typed-error mapping in
 * `src/errors.ts` resolve codes through {@link CONTRACT_ERROR_RANGES}, so a
 * single code can never be claimed by two different contracts.
 */

/** Error codes for Pair contracts (100-119) */
export const PAIR_ERROR_MAP: Record<number, string> = {
    100: 'Pair already initialized',
    101: 'Zero address provided',
    102: 'Identical tokens provided',
    103: 'Insufficient liquidity minted',
    104: 'Insufficient liquidity burned',
    105: 'Insufficient output amount',
    106: 'Insufficient liquidity in pool',
    107: 'Invalid amount',
    108: 'K invariant violated',
    109: 'Insufficient input amount',
    110: 'Contract is locked (reentrancy guard)',
    111: 'Transaction expired (deadline exceeded)',
    112: 'Constraint not met',
    113: 'Invalid fee configuration',
};

/** Error codes for Router contract (200-219) */
export const ROUTER_ERROR_MAP: Record<number, string> = {
    200: 'Router already initialized',
    201: 'Invalid swap path',
    202: 'Insufficient output amount',
    203: 'Excessive input amount',
    204: 'Expired deadline',
    205: 'Insufficient liquidity',
    206: 'Pair not found',
    207: 'Identical tokens',
};

/** Error codes for Factory contract (300-319) */
export const FACTORY_ERROR_MAP: Record<number, string> = {
    300: 'Factory already initialized',
    301: 'Unauthorized caller',
    302: 'Pair already exists',
    303: 'Zero address provided',
    304: 'Invalid fee configuration',
};

/** The contract that owns a given block of error codes. */
export type ContractScope = 'pair' | 'router' | 'factory';

/** A half-open [start, end) block of error codes owned by one contract. */
export interface ContractErrorRange {
    /** The contract that owns this block. */
    scope: ContractScope;
    /** First code in the block (inclusive). */
    start: number;
    /** First code after the block (exclusive). */
    end: number;
    /** Code-to-message lookup for this block. */
    map: Record<number, string>;
}

/**
 * Canonical, non-overlapping contract error code ranges.
 *
 * Every consumer that needs to know which contract a numeric code came from
 * must resolve it through this table rather than hard-coding range checks,
 * so the ranges can only ever be changed in one place.
 */
export const CONTRACT_ERROR_RANGES: readonly ContractErrorRange[] = [
    { scope: 'pair', start: 100, end: 120, map: PAIR_ERROR_MAP },
    { scope: 'router', start: 200, end: 220, map: ROUTER_ERROR_MAP },
    { scope: 'factory', start: 300, end: 320, map: FACTORY_ERROR_MAP },
];

/**
 * Utility for parsing numerical Soroban contract error codes and 
 * converting them into descriptive labels.
 */
export class ErrorParser {
    /**
     * Resolve which contract a numeric error code belongs to.
     *
     * @param code - The numerical error code (e.g. 206).
     * @returns The owning contract scope, or null if the code is out of range.
     */
    static resolveScope(code: number): ContractScope | null {
        const range = CONTRACT_ERROR_RANGES.find(
            (candidate) => code >= candidate.start && code < candidate.end,
        );
        return range ? range.scope : null;
    }

    /**
     * Resolve a contract error code to a descriptive message.
     *
     * @param code - The numerical error code (e.g. 101).
     * @returns A descriptive message, or null if the code is unrecognized.
     */
    static parseContractError(code: number): string | null {
        const range = CONTRACT_ERROR_RANGES.find(
            (candidate) => code >= candidate.start && code < candidate.end,
        );
        if (!range) return null;
        return range.map[code] || null;
    }

    /**
     * Extract a numerical error code from a Soroban RPC error string or object.
     *
     * Recognizes formats like:
     * - "Error(Contract, #101)"
     * - "HostError: Error(Contract, #101)"
     * - { message: "...", code: -32603, data: { ... } }
     *
     * @param error - The raw error from the RPC or SDK.
     * @returns The parsed numerical code, or null if none found.
     */
    static extractErrorCode(error: unknown): number | null {
        if (!error) return null;
        let message = '';
        if (typeof error === 'string') {
            message = error;
        } else if (typeof error === 'object') {
            const errObj = error as Record<string, unknown>;
            if (typeof errObj.message === 'string') {
                message = errObj.message;
            } else if (errObj.message !== undefined && errObj.message !== null) {
                message = String(errObj.message);
            }
        }
        if (!message) return null;

        // Look for Error(Contract, #XXX) or Error(Contract, XXX)
        const match = message.match(/Error\(Contract,\s*#?([0-9]+)\)/i);
        if (match) {
            return parseInt(match[1], 10);
        }

        return null;
    }

    /**
     * Convert any error into a human-friendly message, resolving contract codes if present.
     *
     * @param error - The raw error to process.
     * @returns A descriptive error message.
     */
    static toHumanMessage(error: unknown): string {
        const code = this.extractErrorCode(error);
        if (code !== null) {
            const description = this.parseContractError(code);
            if (description) {
                return `Contract Error (${code}): ${description}`;
            }
            return `Contract Error (${code})`;
        }

        if (typeof error === 'string') return error;
        if (error && typeof error === 'object') {
            const errObj = error as Record<string, unknown>;
            if (typeof errObj.message === 'string') return errObj.message;
        }
        return 'Unknown error';
    }
}
