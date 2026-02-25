import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk';

/**
 * Address utilities for Stellar/Soroban address handling.
 */

/**
 * Validate a Stellar public key (G... address).
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
 */
export function isValidAddress(address: string): boolean {
  return isValidPublicKey(address) || isValidContractId(address);
}

/**
 * Sort two token addresses deterministically (for pair lookups).
 *
 * CoralSwap Factory sorts tokens: token0 < token1.
 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  if (tokenA === tokenB) throw new Error('Identical tokens');
  return tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Truncate an address for display (e.g., "GABC...WXYZ").
 */
export function truncateAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Convert a Stellar address string to an Address ScVal for contract calls.
 */
export function toScAddress(address: string): Address {
  return Address.fromString(address);
}

/**
 * Derive the deterministic pair contract address off-chain.
 *
 * Mirrors the on-chain factory's CREATE2-style derivation:
 * salt = sha256(token0_bytes || token1_bytes), where token0 < token1.
 * Contract ID = sha256(HashIdPreimage(networkId, factory, salt)).
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
