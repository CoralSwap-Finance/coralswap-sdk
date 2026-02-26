import { Network } from "./common";

/**
 * A single token entry in a Stellar token list.
 */
export interface Token {
  /** Soroban contract address or classic asset in `CODE:ISSUER` format. */
  address: string;
  /** Human-readable token name. */
  name: string;
  /** Short ticker symbol. */
  symbol: string;
  /** Number of decimal places. */
  decimals: number;
  /** Network where the token is deployed. */
  network: Network;
  /** Optional URI pointing to the token logo. */
  logoURI?: string;
  /** Optional tags for categorisation (e.g. "stablecoin", "wrapped"). */
  tags?: string[];
}

/**
 * Semantic version of a token list.
 */
export interface TokenListVersion {
  /** Major version, incremented for breaking changes */
  major: number;
  /** Minor version, incremented for added tokens */
  minor: number;
  /** Patch version, incremented for minor token updates */
  patch: number;
}

/**
 * A complete token list conforming to a Stellar token list standard.
 */
export interface TokenList {
  /** Display name for this token list. */
  name: string;
  /** Semantic version of the list. */
  version: TokenListVersion;
  /** Timestamp of last update (ISO-8601). */
  timestamp?: string;
  /** Token entries. */
  tokens: Token[];
}
