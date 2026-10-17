import { ErrorParser } from '../src/errors/parser';
import {
    mapError,
    InsufficientLiquidityError,
    ValidationError,
    SlippageError,
    DeadlineError,
    FlashLoanError,
    SimulationError,
    TransactionError,
    SignerError,
} from '../src/errors';

describe('ErrorParser', () => {
    describe('extractErrorCode', () => {
        it('extracts code from standard Soroban error string', () => {
            expect(ErrorParser.extractErrorCode('Error(Contract, #101)')).toBe(101);
            expect(ErrorParser.extractErrorCode('Error(Contract, 101)')).toBe(101);
        });

        it('extracts code from HostError string', () => {
            expect(ErrorParser.extractErrorCode('HostError: Error(Contract, #102)')).toBe(102);
        });

        it('extracts code from error object message', () => {
            expect(ErrorParser.extractErrorCode({ message: 'Error(Contract, #103)' })).toBe(103);
        });

        it('returns null for unrelated errors', () => {
            expect(ErrorParser.extractErrorCode('Some other error')).toBeNull();
            expect(ErrorParser.extractErrorCode(null)).toBeNull();
        });
    });

    describe('parseContractError', () => {
        it('maps Pair error codes', () => {
            expect(ErrorParser.parseContractError(100)).toBe('Pair already initialized');
            expect(ErrorParser.parseContractError(106)).toBe('Insufficient liquidity in pool');
        });

        it('maps Router error codes', () => {
            expect(ErrorParser.parseContractError(201)).toBe('Invalid swap path');
        });

        it('returns null for unknown codes', () => {
            expect(ErrorParser.parseContractError(999)).toBeNull();
        });
    });

    describe('toHumanMessage', () => {
        it('formats recognized contract errors', () => {
            const msg = ErrorParser.toHumanMessage('Error(Contract, #101)');
            expect(msg).toBe('Contract Error (101): Zero address provided');
        });

        it('returns raw message for unrecognized errors', () => {
            expect(ErrorParser.toHumanMessage('Standard error')).toBe('Standard error');
        });
    });
});

describe('SDK Error Mapping Integration', () => {
    it('maps Error(Contract, #101) to InsufficientLiquidityError', () => {
        const err = mapError('Error(Contract, #101)');
        expect(err).toBeInstanceOf(InsufficientLiquidityError);
    });

    it('maps Error(Contract, #106) to FlashLoanError (Reentrancy)', () => {
        const err = mapError('Error(Contract, #106)');
        expect(err).toBeInstanceOf(FlashLoanError);
        expect(err.message).toContain('Reentrancy');
    });

    it('maps Error(Contract, #102) to SlippageError', () => {
        const err = mapError('Error(Contract, #102)');
        expect(err).toBeInstanceOf(SlippageError);
    });

    it('maps Error(Contract, #103) to DeadlineError', () => {
        const err = mapError('Error(Contract, #103)');
        expect(err).toBeInstanceOf(DeadlineError);
    });

    it('maps Error(Contract, #105) to ValidationError (Insufficient input amount)', () => {
        const err = mapError('Error(Contract, #105)');
        expect(err).toBeInstanceOf(ValidationError);
    });

    it('maps Error(Contract, #111) to ValidationError (Invalid recipient)', () => {
        const err = mapError('Error(Contract, #111)');
        expect(err).toBeInstanceOf(ValidationError);
    });

    it('maps Soroban auth failure strings to SignerError', () => {
        expect(mapError('tx auth failed: missing authorization')).toBeInstanceOf(SignerError);
        expect(mapError('HostError: auth required')).toBeInstanceOf(SignerError);
    });

    it('maps Soroban budget exhaustion to SimulationError', () => {
        const err = mapError('simulation failed: out of budget');
        expect(err).toBeInstanceOf(SimulationError);
        expect(err.message).toContain('out of budget');
    });

    it('maps Soroban bad sequence strings to TransactionError', () => {
        const err = mapError('Transaction failed: tx_bad_seq');
        expect(err).toBeInstanceOf(TransactionError);
        expect(err.message).toContain('tx_bad_seq');
    });
});
