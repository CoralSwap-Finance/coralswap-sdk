/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  testTimeout: 120_000, // testnet txs can be slow
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Type-checking is enforced separately via `tsc --noEmit`.
        diagnostics: false,
        tsconfig: {
          types: ['jest', 'node'],
        },
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
