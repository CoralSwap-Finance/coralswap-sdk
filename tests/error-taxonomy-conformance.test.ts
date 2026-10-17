/**
 * Error Taxonomy Conformance Test
 * Ensures all public-module throws are SDK error classes
 * Validates the ERROR_TAXONOMY table against actual error classes
 */

import {
  ERROR_TAXONOMY,
  CoralSwapSDKError,
  NetworkError,
  RpcError,
  SimulationError,
  TransactionError,
  DeadlineError,
  SlippageError,
  InsufficientLiquidityError,
  PairNotFoundError,
  WebhookDeliveryError,
  ValidationError,
  InvalidThresholdError,
  FlashLoanError,
  FlashLoanFailedError,
  CrossChainError,
  CircuitBreakerError,
  PriceDeviationError,
  StaleOracleError,
  SignerError,
  OrderNotFoundError,
  InvalidOperationError,
  StakingError,
  CooldownError,
  MissingPriceFeedError,
  WebhookError,
  AddressNotFoundError,
  PortfolioCalculationError,
  WebhookDisabledError,
  DecodeError,
} from '@/errors';

describe('Error Taxonomy Conformance', () => {
  const errorClassMap: Record<string, typeof CoralSwapSDKError> = {
    NetworkError,
    RpcError,
    SimulationError,
    TransactionError,
    DeadlineError,
    SlippageError,
    InsufficientLiquidityError,
    PairNotFoundError,
    WebhookDeliveryError,
    ValidationError,
    InvalidThresholdError,
    FlashLoanError,
    FlashLoanFailedError,
    CrossChainError,
    CircuitBreakerError,
    PriceDeviationError,
    StaleOracleError,
    SignerError,
    OrderNotFoundError,
    InvalidOperationError,
    StakingError,
    CooldownError,
    MissingPriceFeedError,
    WebhookError,
    AddressNotFoundError,
    PortfolioCalculationError,
    WebhookDisabledError,
    DecodeError,
  };

  describe('ERROR_TAXONOMY table validation', () => {
    it('should list every documented error class', () => {
      const taxonomyClasses = ERROR_TAXONOMY.map((entry) => entry.class);
      const classNames = Object.keys(errorClassMap);

      const missing = classNames.filter((name) => !taxonomyClasses.includes(name));
      if (missing.length > 0) {
        throw new Error(
          `ERROR_TAXONOMY missing entries for: ${missing.join(', ')}. ` +
          `Add these to ERROR_TAXONOMY in src/errors.ts`,
        );
      }
    });

    it('should have valid error codes (non-empty strings)', () => {
      const invalidCodes = ERROR_TAXONOMY.filter(
        (entry) => !entry.code || entry.code.trim() === '' || typeof entry.code !== 'string',
      );

      expect(invalidCodes).toHaveLength(0);
      if (invalidCodes.length > 0) {
        throw new Error(
          `Invalid error codes in ERROR_TAXONOMY: ${JSON.stringify(invalidCodes)}`,
        );
      }
    });

    it('should have valid retry policies', () => {
      const validPolicies = ['retry-with-backoff', 'fail-fast', 'none'];
      const invalid = ERROR_TAXONOMY.filter(
        (entry) => !validPolicies.includes(entry.retryPolicy),
      );

      expect(invalid).toHaveLength(0);
      if (invalid.length > 0) {
        throw new Error(
          `Invalid retry policies: ${JSON.stringify(invalid)}. ` +
          `Must be one of: ${validPolicies.join(', ')}`,
        );
      }
    });
  });

  describe('Every error class extends CoralSwapSDKError', () => {
    Object.entries(errorClassMap).forEach(([className, errorClass]) => {
      it(`${className} should extend CoralSwapSDKError`, () => {
        // Create a test instance
        let instance: CoralSwapSDKError;

        if (className === 'NetworkError') {
          instance = new NetworkError('test');
        } else if (className === 'RpcError') {
          instance = new RpcError('test');
        } else if (className === 'SimulationError') {
          instance = new SimulationError('test');
        } else if (className === 'TransactionError') {
          instance = new TransactionError('test');
        } else if (className === 'DeadlineError') {
          instance = new DeadlineError(123);
        } else if (className === 'SlippageError') {
          instance = new SlippageError(100n, 90n, 100);
        } else if (className === 'InsufficientLiquidityError') {
          instance = new InsufficientLiquidityError('CABC');
        } else if (className === 'PairNotFoundError') {
          instance = new PairNotFoundError('CABC', 'CDEF');
        } else if (className === 'WebhookDeliveryError') {
          instance = new WebhookDeliveryError('webhook-id', 500, 3);
        } else if (className === 'ValidationError') {
          instance = new ValidationError('test');
        } else if (className === 'InvalidThresholdError') {
          instance = new InvalidThresholdError('test', 50, 0, 100);
        } else if (className === 'FlashLoanError') {
          instance = new FlashLoanError('test');
        } else if (className === 'FlashLoanFailedError') {
          instance = new FlashLoanFailedError('test');
        } else if (className === 'CrossChainError') {
          instance = new CrossChainError('test');
        } else if (className === 'CircuitBreakerError') {
          instance = new CircuitBreakerError('CABC');
        } else if (className === 'PriceDeviationError') {
          instance = new PriceDeviationError(100, 110, 200);
        } else if (className === 'StaleOracleError') {
          instance = new StaleOracleError('XLM', 1000, 5000);
        } else if (className === 'SignerError') {
          instance = new SignerError();
        } else if (className === 'OrderNotFoundError') {
          instance = new OrderNotFoundError('order-123');
        } else if (className === 'InvalidOperationError') {
          instance = new InvalidOperationError('test');
        } else if (className === 'StakingError') {
          instance = new StakingError('test');
        } else if (className === 'CooldownError') {
          instance = new CooldownError(123456);
        } else if (className === 'MissingPriceFeedError') {
          instance = new MissingPriceFeedError('CABC');
        } else if (className === 'WebhookError') {
          instance = new WebhookError('test');
        } else if (className === 'AddressNotFoundError') {
          instance = new AddressNotFoundError('CABC', 'testnet');
        } else if (className === 'PortfolioCalculationError') {
          instance = new PortfolioCalculationError('CABC', 'test reason');
        } else if (className === 'WebhookDisabledError') {
          instance = new WebhookDisabledError('webhook-123', 5);
        } else if (className === 'DecodeError') {
          instance = new DecodeError('slot-name');
        } else {
          throw new Error(`Unknown error class: ${className}`);
        }

        expect(instance).toBeInstanceOf(CoralSwapSDKError);
        expect(instance).toBeInstanceOf(Error);
      });
    });
  });

  describe('Every error class has required properties', () => {
    Object.entries(errorClassMap).forEach(([className, errorClass]) => {
      it(`${className} should have code and name properties`, () => {
        let instance: CoralSwapSDKError;

        if (className === 'NetworkError') {
          instance = new NetworkError('test message');
        } else if (className === 'RpcError') {
          instance = new RpcError('test message');
        } else if (className === 'SimulationError') {
          instance = new SimulationError('test message');
        } else if (className === 'TransactionError') {
          instance = new TransactionError('test message');
        } else if (className === 'DeadlineError') {
          instance = new DeadlineError(123);
        } else if (className === 'SlippageError') {
          instance = new SlippageError(100n, 90n, 100);
        } else if (className === 'InsufficientLiquidityError') {
          instance = new InsufficientLiquidityError('CABC');
        } else if (className === 'PairNotFoundError') {
          instance = new PairNotFoundError('CABC', 'CDEF');
        } else if (className === 'WebhookDeliveryError') {
          instance = new WebhookDeliveryError('webhook-id', 500, 3);
        } else if (className === 'ValidationError') {
          instance = new ValidationError('test message');
        } else if (className === 'InvalidThresholdError') {
          instance = new InvalidThresholdError('test', 50, 0, 100);
        } else if (className === 'FlashLoanError') {
          instance = new FlashLoanError('test message');
        } else if (className === 'FlashLoanFailedError') {
          instance = new FlashLoanFailedError('test message');
        } else if (className === 'CrossChainError') {
          instance = new CrossChainError('test message');
        } else if (className === 'CircuitBreakerError') {
          instance = new CircuitBreakerError('CABC');
        } else if (className === 'PriceDeviationError') {
          instance = new PriceDeviationError(100, 110, 200);
        } else if (className === 'StaleOracleError') {
          instance = new StaleOracleError('XLM', 1000, 5000);
        } else if (className === 'SignerError') {
          instance = new SignerError();
        } else if (className === 'OrderNotFoundError') {
          instance = new OrderNotFoundError('order-123');
        } else if (className === 'InvalidOperationError') {
          instance = new InvalidOperationError('test message');
        } else if (className === 'StakingError') {
          instance = new StakingError('test message');
        } else if (className === 'CooldownError') {
          instance = new CooldownError(123456);
        } else if (className === 'MissingPriceFeedError') {
          instance = new MissingPriceFeedError('CABC');
        } else if (className === 'WebhookError') {
          instance = new WebhookError('test message');
        } else if (className === 'AddressNotFoundError') {
          instance = new AddressNotFoundError('CABC', 'testnet');
        } else if (className === 'PortfolioCalculationError') {
          instance = new PortfolioCalculationError('CABC', 'test reason');
        } else if (className === 'WebhookDisabledError') {
          instance = new WebhookDisabledError('webhook-123', 5);
        } else if (className === 'DecodeError') {
          instance = new DecodeError('slot-name');
        } else {
          throw new Error(`Unknown error class: ${className}`);
        }

        expect(instance).toHaveProperty('code');
        expect(instance).toHaveProperty('name');
        expect(typeof instance.code).toBe('string');
        expect(typeof instance.name).toBe('string');
        expect(instance.name).toBe(className);

        const taxonomyEntry = ERROR_TAXONOMY.find((e) => e.class === className);
        expect(taxonomyEntry).toBeDefined();
        expect(instance.code).toBe(taxonomyEntry!.code);
      });
    });
  });

  describe('Error JSON serialization', () => {
    it('should serialize all errors to JSON correctly', () => {
      const testCases = [
        { error: new NetworkError('network failed'), expectedCode: 'NETWORK_ERROR' },
        { error: new ValidationError('invalid'), expectedCode: 'VALIDATION_ERROR' },
        { error: new SignerError(), expectedCode: 'NO_SIGNER' },
        { error: new DeadlineError(999), expectedCode: 'DEADLINE_EXCEEDED' },
      ];

      testCases.forEach(({ error, expectedCode }) => {
        const json = error.toJSON();

        expect(json).toHaveProperty('name');
        expect(json).toHaveProperty('code');
        expect(json).toHaveProperty('message');
        expect(json.code).toBe(expectedCode);
        expect(typeof json.message).toBe('string');
      });
    });
  });

  describe('Retry policy consistency', () => {
    it('should have networkish errors with retry-with-backoff policy', () => {
      const networkishErrors = ['NetworkError', 'RpcError', 'WebhookDeliveryError'];
      const entries = ERROR_TAXONOMY.filter((e) => networkishErrors.includes(e.class));

      entries.forEach((entry) => {
        expect(entry.retryPolicy).toBe('retry-with-backoff');
      });
    });

    it('should have validation errors with fail-fast policy', () => {
      const validationishErrors = [
        'ValidationError',
        'InvalidThresholdError',
        'SlippageError',
        'DeadlineError',
      ];
      const entries = ERROR_TAXONOMY.filter((e) => validationishErrors.includes(e.class));

      entries.forEach((entry) => {
        expect(entry.retryPolicy).toBe('fail-fast');
      });
    });
  });

  describe('Error hierarchy inheritance validation', () => {
    it('should respect inheritance hierarchy', () => {
      // FlashLoanFailedError extends FlashLoanError extends TransactionError
      const flashLoanFailed = new FlashLoanFailedError('test');
      expect(flashLoanFailed).toBeInstanceOf(FlashLoanFailedError);
      expect(flashLoanFailed).toBeInstanceOf(FlashLoanError);
      expect(flashLoanFailed).toBeInstanceOf(TransactionError);
      expect(flashLoanFailed).toBeInstanceOf(CoralSwapSDKError);

      // CrossChainError extends TransactionError
      const crossChain = new CrossChainError('test');
      expect(crossChain).toBeInstanceOf(CrossChainError);
      expect(crossChain).toBeInstanceOf(TransactionError);
      expect(crossChain).toBeInstanceOf(CoralSwapSDKError);

      // WebhookDisabledError extends WebhookError
      const webhookDisabled = new WebhookDisabledError('webhook-id', 5);
      expect(webhookDisabled).toBeInstanceOf(WebhookDisabledError);
      expect(webhookDisabled).toBeInstanceOf(WebhookError);
      expect(webhookDisabled).toBeInstanceOf(CoralSwapSDKError);

      // InvalidThresholdError extends ValidationError
      const invalidThreshold = new InvalidThresholdError('test', 50, 0, 100);
      expect(invalidThreshold).toBeInstanceOf(InvalidThresholdError);
      expect(invalidThreshold).toBeInstanceOf(ValidationError);
      expect(invalidThreshold).toBeInstanceOf(CoralSwapSDKError);
    });
  });

  describe('No orphaned error classes', () => {
    it('should not have unmapped error classes', () => {
      // This ensures every exported error class has a corresponding ERROR_TAXONOMY entry
      const taxonomyClasses = ERROR_TAXONOMY.map((e) => e.class);
      const exportedClasses = Object.keys(errorClassMap);

      const orphaned = exportedClasses.filter((name) => !taxonomyClasses.includes(name));
      expect(orphaned).toHaveLength(0);

      if (orphaned.length > 0) {
        throw new Error(
          `Orphaned error classes (exported but not in ERROR_TAXONOMY): ${orphaned.join(', ')}. ` +
          `Add these to ERROR_TAXONOMY in src/errors.ts`,
        );
      }
    });
  });

  describe('Error codes are unique per error class', () => {
    it('should have no duplicate class names in ERROR_TAXONOMY', () => {
      const classNames = ERROR_TAXONOMY.map((e) => e.class);
      const duplicates = classNames.filter((name, idx) => classNames.indexOf(name) !== idx);

      expect(duplicates).toHaveLength(0);
      if (duplicates.length > 0) {
        throw new Error(`Duplicate error classes in ERROR_TAXONOMY: ${duplicates.join(', ')}`);
      }
    });
  });
});
