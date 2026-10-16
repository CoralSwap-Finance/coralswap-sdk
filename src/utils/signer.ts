import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Signer } from '../types/common';
import { ValidationError } from '../errors';

/**
 * Throw a descriptive error if a signer bound to `signerPassphrase` is used
 * with a client configured for `expectedPassphrase`.
 *
 * A transaction built for one network parses and signs fine under another
 * network's passphrase; the mismatch only surfaces at submission as an
 * opaque auth failure. This check makes it fail fast instead.
 */
export function assertSignerNetwork(
  signerPassphrase: string | undefined,
  expectedPassphrase: string,
): void {
  if (signerPassphrase === undefined) return;
  if (signerPassphrase !== expectedPassphrase) {
    throw new ValidationError(
      `Signer network mismatch: signer is bound to "${signerPassphrase}" ` +
        `but the client is configured for "${expectedPassphrase}". ` +
        'Transactions signed with the wrong network passphrase will be rejected at submission.',
      { signerPassphrase, expectedPassphrase },
    );
  }
}

export class KeypairSigner implements Signer {
  private readonly keypair: Keypair;
  readonly networkPassphrase: string;
  readonly publicKeySync: string;

  /**
   * @param secretKey - Stellar secret seed (S...).
   * @param networkPassphrase - Passphrase used to sign transactions.
   * @param expectedNetworkPassphrase - The client's configured network
   *   passphrase. When provided, construction fails fast if it does not
   *   match `networkPassphrase`.
   */
  constructor(secretKey: string, networkPassphrase: string, expectedNetworkPassphrase?: string) {
    if (typeof networkPassphrase !== 'string' || networkPassphrase.trim() === '') {
      throw new ValidationError('KeypairSigner requires a non-empty network passphrase');
    }
    if (expectedNetworkPassphrase !== undefined) {
      assertSignerNetwork(networkPassphrase, expectedNetworkPassphrase);
    }
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = networkPassphrase;
    this.publicKeySync = this.keypair.publicKey();
  }

  async publicKey(): Promise<string> {
    return this.publicKeySync;
  }

  async signTransaction(txXdr: string): Promise<string> {
    const tx = new Transaction(txXdr, this.networkPassphrase);
    tx.sign(this.keypair);
    return tx.toXdr();
  }
}
