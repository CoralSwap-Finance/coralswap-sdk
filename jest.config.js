/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['tests/integration/'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary', 'text-summary'],
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 60,
      functions: 74,
      lines: 78,
    },
    // Per-module regression thresholds for core modules that previously had bugs.
    // Thresholds are set slightly below current coverage to prevent regression
    // without blocking minor fluctuations.
    'src/modules/monitoring.ts': {
      statements: 34,
      branches: 24,
      functions: 22,
      lines: 40,
    },
    'src/modules/webhooks.ts': {
      statements: 63,
      branches: 60,
      functions: 62,
      lines: 66,
    },
    'src/modules/alerts.ts': {
      statements: 36,
      branches: 27,
      functions: 32,
      lines: 38,
    },
    'src/modules/liquidity.ts': {
      statements: 60,
      branches: 50,
      functions: 60,
      lines: 65,
    },
    'src/errors.ts': {
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 75,
    },
    'src/modules/tax-reporting.ts': {
      statements: 50,
      branches: 61,
      functions: 50,
      lines: 55,
    },
    'src/utils/events.ts': {
      statements: 80,
      branches: 70,
      functions: 90,
      lines: 85,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Suppress pre-existing type errors in source files so tests can run.
        // Type-checking is enforced separately via `tsc --noEmit`.
        diagnostics: false,
      },
    ],
    '^.+\\.jsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@stellar/stellar-sdk|@stellar/js-xdr|@noble/ed25519|@noble/hashes|uint8array-extras|@exodus/bytes|zod)/)',
  ],
};
