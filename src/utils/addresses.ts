import { Address, Asset, StrKey, hash, xdr } from "@stellar/stellar-sdk";

/**
 * Address utilities for Stellar/Soroban address handling.
 */

/**
 * Validate a Stellar public key (G... address).
 *
 * Checks if the provided string is a valid Stellar Ed25519 public key.
 * Valid public keys start with 'G' and are 56 characters long.
 *
 * @param address - The address string to validate
 * @returns `true` if the address is a valid Stellar public key, `false` otherwise
 *
 * @example
 * ```ts
 * isValidPublicKey('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'); // true
 * isValidPublicKey('CABC123...'); // false (contract address)
 * isValidPublicKey('invalid'); // false
 * ```
 */
export function isValidPublicKey(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Validate a Soroban contract address (C... address).
 *
 * Checks if the provided string is a valid Soroban contract identifier.
 * Valid contract addresses start with 'C' and are 56 characters long.
 *
 * @param address - The address string to validate
 * @returns `true` if the address is a valid Soroban contract ID, `false` otherwise
 *
 * @example
 * ```ts
 * isValidContractId('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'); // true
 * isValidContractId('GBRPYHIL...'); // false (public key)
 * isValidContractId('invalid'); // false
 * ```
 */
export function isValidContractId(address: string): boolean {
  try {
    return StrKey.isValidContract(address);
  } catch {
    return false;
  }
}

/**
 * Validate any Stellar address (public key or contract).
 *
 * General-purpose address validator that handles both Stellar Public Keys (G...)
 * and Soroban Contract IDs (C...), returning a boolean indicating validity.
 * This is the recommended function for validating addresses when you don't know
 * the specific type in advance.
 *
 * @param address - The address string to validate
 * @returns `true` if the address is a valid Stellar public key or Soroban contract ID, `false` otherwise
 *
 * @example
 * ```ts
 * isValidAddress('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'); // true
 * isValidAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'); // true
 * isValidAddress('invalid'); // false
 * isValidAddress(''); // false
 * ```
 */
export function isValidAddress(address: string): boolean {
  return isValidPublicKey(address) || isValidContractId(address);
}

/**
 * Determine whether a token identifier refers to the native XLM asset.
 *
 * Accepts common native identifiers like "XLM" or "native" (case-insensitive).
 * Valid Stellar account or contract addresses are never treated as native.
 * The identifier is trimmed and normalized before checking.
 *
 * @param identifier - The token identifier to check (e.g., "XLM", "native", or an address)
 * @returns `true` if the identifier represents the native XLM asset, `false` otherwise
 *
 * @example
 * ```ts
 * isNativeToken('XLM'); // true
 * isNativeToken('native'); // true
 * isNativeToken('NATIVE'); // true
 * isNativeToken('  xlm  '); // true (trimmed and normalized)
 * isNativeToken('GBRPYHIL...'); // false (valid address)
 * isNativeToken('USDC'); // false
 * isNativeToken(''); // false
 * ```
 */
export function isNativeToken(identifier: string): boolean {
  const normalized = identifier.trim();
  if (!normalized) return false;

  const upper = normalized.toUpperCase();

  // If this looks like a real on-chain address, it is not the native asset.
  if (isValidAddress(upper)) {
    return false;
  }

  return upper === "XLM" || upper === "NATIVE";
}

/**
 * Return the Stellar Asset Contract (SAC) address for native XLM on the given network.
 *
 * The contract ID is derived deterministically from the network passphrase.
 * Use this when you need the on-chain contract address for the native asset (e.g. for
 * Router or Pair interactions). The contract must exist on the network (SAC is
 * deployed by the network).
 */
export function getNativeAssetContractAddress(networkPassphrase: string): string {
  const native = Asset.native();
  return native.contractId(networkPassphrase);
}

/**
 * Resolve a token identifier to an on-chain contract address.
 *
 * If the identifier is a native token label (e.g. "XLM" or "native"), returns the
 * Stellar Asset Contract address for the given network. Otherwise returns the
 * identifier unchanged (assumed to be already a contract address).
 */
export function resolveTokenIdentifier(
  identifier: string,
  networkPassphrase: string,
): string {
  if (isNativeToken(identifier)) {
    return getNativeAssetContractAddress(networkPassphrase);
  }
  return identifier;
}

/**
 * Sort two token addresses deterministically (for pair lookups).
 *
 * CoralSwap Factory sorts tokens lexicographically: token0 < token1.
 * This ensures consistent pair identification regardless of input order.
 * Throws an error if both addresses are identical.
 *
 * @param tokenA - First token address
 * @param tokenB - Second token address
 * @returns A tuple `[token0, token1]` where token0 < token1 lexicographically
 * @throws {Error} If tokenA and tokenB are identical
 *
 * @example
 * ```ts
 * sortTokens('CDEF...', 'CABC...'); // ['CABC...', 'CDEF...']
 * sortTokens('CABC...', 'CDEF...'); // ['CABC...', 'CDEF...']
 * sortTokens('CABC...', 'CABC...'); // throws Error: "Identical tokens"
 * ```
 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  if (tokenA === tokenB) throw new Error("Identical tokens");
  return tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Truncate an address for display purposes.
 *
 * Creates a shortened version of an address by keeping the first and last
 * N characters and replacing the middle with "...". Useful for UI display
 * where full addresses are too long.
 *
 * @param address - The full address to truncate
 * @param chars - Number of characters to keep from start and end (default: 4)
 * @returns The truncated address string (e.g., "GABC...WXYZ")
 *
 * @example
 * ```ts
 * truncateAddress('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H');
 * // Returns: 'GBRP...OX2H'
 *
 * truncateAddress('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', 6);
 * // Returns: 'GBRPYH...C7OX2H'
 *
 * truncateAddress('SHORT'); // Returns: 'SHORT' (too short to truncate)
 * ```
 */
export function truncateAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Convert a Stellar address string to an Address object for contract calls.
 *
 * Transforms a string representation of a Stellar address (public key or contract)
 * into an Address object that can be used in Soroban smart contract invocations.
 * This is required when passing addresses as parameters to contract functions.
 *
 * @param address - The Stellar address string (G... or C...)
 * @returns An Address object suitable for Soroban contract calls
 * @throws {Error} If the address string is invalid
 *
 * @example
 * ```ts
 * const addr = toScAddress('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H');
 * // Use addr in contract.call(..., addr, ...)
 *
 * const contractAddr = toScAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
 * // Use contractAddr in contract invocations
 * ```
 */
export function toScAddress(address: string): Address {
  return Address.fromString(address);
}

/**
 * Derive the deterministic pair contract address off-chain.
 *
 * Computes the contract address for a token pair without querying the blockchain.
 * This mirrors the on-chain factory's CREATE2-style derivation algorithm:
 * 1. Sort tokens lexicographically (token0 < token1)
 * 2. Calculate salt = sha256(token0_bytes || token1_bytes)
 * 3. Derive contract ID = sha256(HashIdPreimage(networkId, factory, salt))
 *
 * This allows you to predict pair addresses before they're deployed, which is
 * useful for checking if a pair exists or preparing transactions.
 *
 * @param factoryAddress - The CoralSwap factory contract address
 * @param tokenA - First token address
 * @param tokenB - Second token address
 * @param networkPassphrase - The Stellar network passphrase (e.g., "Public Global Stellar Network ; September 2015")
 * @returns The deterministic pair contract address
 * @throws {Error} If tokenA and tokenB are identical
 *
 * @example
 * ```ts
 * const pairAddress = getPairAddress(
 *   'CFACTORY123...', // factory address
 *   'CTOKEN1...', // token A
 *   'CTOKEN2...', // token B
 *   'Test SDF Network ; September 2015'
 * );
 * // Returns: 'CPAIR123...'
 *
 * // Order doesn't matter - same result:
 * getPairAddress(factory, tokenA, tokenB, network) ===
 * getPairAddress(factory, tokenB, tokenA, network); // true
 * ```
 */
export function getPairAddress(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  networkPassphrase: string,
): string {
  const [token0, token1] = sortTokens(tokenA, tokenB);

  const salt = hash(
    Buffer.concat([
      Address.fromString(token0).toBuffer(),
      Address.fromString(token1).toBuffer(),
    ]),
  );

  const networkId = hash(Buffer.from(networkPassphrase));

  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(factoryAddress).toScAddress(),
          salt,
        }),
      ),
    }),
  );

  return StrKey.encodeContract(hash(preimage.toXDR()));
}
