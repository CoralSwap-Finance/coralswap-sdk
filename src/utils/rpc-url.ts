import { Network } from '@/types/common';
import { ValidationError } from '@/errors';

/**
 * RPC URL scheme validation.
 *
 * Pointing an RPC endpoint at a cleartext (`http`/`ws`) URL silently
 * transmits signed transactions over the wire, exposing them to network
 * observers. Production configurations (mainnet) therefore reject
 * cleartext endpoints. Dev/test networks (testnet, staging) are
 * explicitly labelled as dev/test and may use cleartext endpoints for
 * local development.
 */

/** Secure RPC schemes allowed for every network. */
export const SECURE_RPC_SCHEMES = ['https', 'wss'] as const;

/** Every RPC scheme understood by the SDK. */
export const ALLOWED_RPC_SCHEMES = ['http', 'https', 'ws', 'wss'] as const;

export type RpcUrlScheme = (typeof ALLOWED_RPC_SCHEMES)[number];

/**
 * Extract the scheme (lowercase, without the ':') from an RPC URL.
 *
 * @param rpcUrl - The RPC endpoint URL.
 * @returns The scheme (e.g. `"https"`) or `null` when the URL is malformed.
 */
export function getRpcUrlScheme(rpcUrl: string): string | null {
  try {
    return new URL(rpcUrl).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether an RPC URL uses a secure transport (https or wss).
 */
export function isSecureRpcUrl(rpcUrl: string): boolean {
  const scheme = getRpcUrlScheme(rpcUrl);
  return scheme === 'https' || scheme === 'wss';
}

/**
 * Whether cleartext (`http`/`ws`) RPC endpoints are permitted for a network.
 *
 * Only explicitly dev/test networks (testnet, staging) permit cleartext.
 * Production (mainnet) configs never do.
 */
export function isCleartextRpcAllowed(network: Network): boolean {
  return network !== Network.MAINNET;
}

/**
 * Validate RPC endpoint URL(s) for a network.
 *
 * Rejects malformed URLs, unsupported schemes, and cleartext (`http`/`ws`)
 * endpoints on production (mainnet) configs. Cleartext endpoints are only
 * accepted for explicitly dev/test networks (testnet, staging).
 *
 * @param rpcUrls - A single RPC URL or an array of fallback URLs.
 * @param network - The network the URLs will be used against.
 * @param label - Human-readable parameter name for error messages.
 * @throws {ValidationError} If any URL is invalid or disallowed.
 */
export function validateRpcUrls(
  rpcUrls: string | string[],
  network: Network,
  label = 'rpcUrl',
): void {
  const urls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];

  for (const url of urls) {
    const scheme = getRpcUrlScheme(url);
    if (scheme === null) {
      throw new ValidationError(
        `${label} is not a valid URL: "${url}"`,
        { url },
      );
    }
    if (!(ALLOWED_RPC_SCHEMES as readonly string[]).includes(scheme)) {
      throw new ValidationError(
        `${label} uses unsupported scheme "${scheme}:". Soroban RPC requires an http(s) or ws(s) endpoint.`,
        { url, scheme },
      );
    }
    if (!isSecureRpcUrl(url) && !isCleartextRpcAllowed(network)) {
      throw new ValidationError(
        `Cleartext ${label} "${url}" is not allowed for production (${network}). ` +
        `Insecure "${scheme}:" endpoints silently transmit signed transactions over the wire. ` +
        `Use an https:// or wss:// endpoint, or configure a dev/test network ` +
        `(Network.TESTNET or Network.STAGING) to allow cleartext RPC.`,
        { url, scheme, network },
      );
    }
  }
}