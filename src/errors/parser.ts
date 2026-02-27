/**
 * Mappings for CoralSwap contract error codes to human-readable messages.
 *
 * These codes are defined in the Soroban contracts using #[contracterror].
 */

/** Error codes for Pair contracts (100-119) */
export const PAIR_ERROR_MAP: Record<number, string> = {
    100: 'Invalid token pair',
    101: 'Insufficient liquidity',
    102: 'Slippage exceeded',
    103: 'Deadline exceeded',
    104: 'Invalid amount',
    105: 'Insufficient input amount',
    106: 'Reentrancy detected',
    107: 'Flash loan callback failed',
    108: 'Flash loan repayment insufficient',
    109: 'Circuit breaker',
    110: 'Unauthorized',
    111: 'Invalid recipient',
    112: 'Overflow',
    113: 'K invariant violated',
};

/** Error codes for Router contract (300-319) */
export const ROUTER_ERROR_MAP: Record<number, string> = {
    300: 'Pair not found',
    301: 'Invalid path',
    302: 'Slippage exceeded',
    303: 'Deadline exceeded',
    304: 'Insufficient liquidity',
    305: 'Excessive input amount',
    306: 'Invalid token',
};

/** Error codes for Factory contract (400-419) */
export const FACTORY_ERROR_MAP: Record<number, string> = {
    400: 'Factory already initialized',
    401: 'Unauthorized caller',
    402: 'Pair already exists',
    403: 'Zero address provided',
    404: 'Invalid fee configuration',
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
        if (code >= 300 && code < 320) return ROUTER_ERROR_MAP[code] || null;
        if (code >= 400 && code < 420) return FACTORY_ERROR_MAP[code] || null;
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
