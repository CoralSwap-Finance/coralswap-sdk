import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Signer } from '../types/common';

export class KeypairSigner implements Signer {
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;
  readonly publicKeySync: string;

  constructor(secretKey: string, networkPassphrase: string) {
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
    return tx.toXDR();
  }
}