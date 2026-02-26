/**
 * Mappings for CoralSwap contract error codes to human-readable messages.
 *
 * These codes are defined in the Soroban contracts using #[contracterror].
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

/**
 * Utility for parsing numerical Soroban contract error codes and 
 * converting them into descriptive labels.
 */
export class ErrorParser {
    /**
     * Resolve a contract error code to a descriptive message.
     *
     * @param code - The numerical error code (e.g. 101).
     * @returns A descriptive message, or null if the code is unrecognized.
     */
    static parseContractError(code: number): string | null {
        if (code >= 100 && code < 120) return PAIR_ERROR_MAP[code] || null;
        if (code >= 200 && code < 220) return ROUTER_ERROR_MAP[code] || null;
        if (code >= 300 && code < 320) return FACTORY_ERROR_MAP[code] || null;
        return null;
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
    static extractErrorCode(error: any): number | null {
        const message = typeof error === 'string' ? error : error?.message || '';
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
    static toHumanMessage(error: any): string {
        const code = this.extractErrorCode(error);
        if (code !== null) {
            const description = this.parseContractError(code);
            if (description) {
                return `Contract Error (${code}): ${description}`;
            }
            return `Contract Error (${code})`;
        }

        return typeof error === 'string' ? error : error?.message || 'Unknown error';
    }
}
