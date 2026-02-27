import { ErrorParser } from '../src/errors/parser';
import { mapError, InsufficientLiquidityError, ValidationError, SlippageError, DeadlineError, FlashLoanError } from '../src/errors';

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
            expect(ErrorParser.parseContractError(100)).toBe('Invalid token pair');
            expect(ErrorParser.parseContractError(101)).toBe('Insufficient liquidity');
        });

        it('maps Router error codes', () => {
            expect(ErrorParser.parseContractError(301)).toBe('Invalid path');
        });

        it('returns null for unknown codes', () => {
            expect(ErrorParser.parseContractError(999)).toBeNull();
        });
    });

    describe('toHumanMessage', () => {
        it('formats recognized contract errors', () => {
            const msg = ErrorParser.toHumanMessage('Error(Contract, #101)');
            expect(msg).toBe('Contract Error (101): Insufficient liquidity');
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

    it('maps Error(Contract, #106) to FlashLoanError', () => {
        const err = mapError('Error(Contract, #106)');
        expect(err).toBeInstanceOf(FlashLoanError);
    });

    it('maps Error(Contract, #102) to SlippageError', () => {
        const err = mapError('Error(Contract, #102)');
        expect(err).toBeInstanceOf(SlippageError);
    });

    it('maps Error(Contract, #103) to DeadlineError', () => {
        const err = mapError('Error(Contract, #103)');
        expect(err).toBeInstanceOf(DeadlineError);
    });
});
