import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { KeypairSigner, assertSignerNetwork } from '../src/utils/signer';
import { ValidationError } from '../src/errors';

describe('KeypairSigner network validation', () => {
  const kp = Keypair.random();

  it('constructs when the passphrase matches the expected network', () => {
    const signer = new KeypairSigner(kp.secret(), Networks.TESTNET, Networks.TESTNET);
    expect(signer.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('fails fast when bound to a different network than the client', () => {
    expect(() => new KeypairSigner(kp.secret(), Networks.PUBLIC, Networks.TESTNET)).toThrow(
      ValidationError,
    );
    expect(() => new KeypairSigner(kp.secret(), Networks.PUBLIC, Networks.TESTNET)).toThrow(
      /network mismatch/i,
    );
  });

  it('rejects an empty passphrase', () => {
    expect(() => new KeypairSigner(kp.secret(), '')).toThrow(ValidationError);
  });

  it('signs for its own network only (cross-network signature is not valid)', async () => {
    const source = new Account(kp.publicKey(), '1');
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();

    const wrongNetworkSigner = new KeypairSigner(kp.secret(), Networks.PUBLIC);
    const signedXdr = await wrongNetworkSigner.signTransaction(tx.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    const sig = signed.signatures[0].signature();
    expect(kp.verify(signed.hash(), sig)).toBe(false);
  });
});

describe('assertSignerNetwork', () => {
  it('is a no-op for signers without a bound network', () => {
    expect(() => assertSignerNetwork(undefined, Networks.TESTNET)).not.toThrow();
  });

  it('throws on mismatch', () => {
    expect(() => assertSignerNetwork(Networks.PUBLIC, Networks.TESTNET)).toThrow(ValidationError);
  });
});
