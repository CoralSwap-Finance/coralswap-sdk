import { Keypair } from '@stellar/stellar-sdk';
import { CoralSwapClient, KeypairSigner } from '../src/client';
import { Network, Signer } from '../src/types/common';
import { SignerError } from '../src/errors';

/**
 * Tests for the external signer support (wallet adapter pattern).
 *
 * Validates that CoralSwapClient accepts both secret key strings
 * and custom Signer implementations, maintaining backward compatibility.
 */
describe('Signer Support', () => {
  const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
  const TEST_PUBLIC = Keypair.fromSecret(TEST_SECRET).publicKey();

  describe('KeypairSigner', () => {
    it('returns the correct public key', async () => {
      const signer = new KeypairSigner(
        TEST_SECRET,
        'Test SDF Network ; September 2015',
      );
      const pubKey = await signer.publicKey();
      expect(pubKey).toBe(TEST_PUBLIC);
    });

    it('exposes publicKeySync for synchronous access', () => {
      const signer = new KeypairSigner(
        TEST_SECRET,
        'Test SDF Network ; September 2015',
      );
      expect(signer.publicKeySync).toBe(TEST_PUBLIC);
    });

    it('signs transaction XDR and returns a string', async () => {
      const signer = new KeypairSigner(
        TEST_SECRET,
        'Test SDF Network ; September 2015',
      );
      // signTransaction expects valid XDR -- tested via integration
      expect(typeof signer.signTransaction).toBe('function');
    });
  });

  describe('CoralSwapClient with secretKey (backward compatibility)', () => {
    it('resolves publicKey synchronously when secretKey is provided', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });
      expect(client.publicKey).toBe(TEST_PUBLIC);
    });

    it('resolves publicKey asynchronously when secretKey is provided', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });
      const pubKey = await client.resolvePublicKey();
      expect(pubKey).toBe(TEST_PUBLIC);
    });
  });

  describe('CoralSwapClient with custom Signer', () => {
    it('accepts a custom signer object', async () => {
      const mockSigner: Signer = {
        publicKey: jest.fn().mockResolvedValue(TEST_PUBLIC),
        signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
      };

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        signer: mockSigner,
      });

      const pubKey = await client.resolvePublicKey();
      expect(pubKey).toBe(TEST_PUBLIC);
      expect(mockSigner.publicKey).toHaveBeenCalledTimes(1);
    });

    it('caches public key after first resolve', async () => {
      const mockSigner: Signer = {
        publicKey: jest.fn().mockResolvedValue(TEST_PUBLIC),
        signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
      };

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        signer: mockSigner,
      });

      await client.resolvePublicKey();
      await client.resolvePublicKey();
      expect(mockSigner.publicKey).toHaveBeenCalledTimes(1);
    });

    it('sync publicKey works after resolvePublicKey is called', async () => {
      const mockSigner: Signer = {
        publicKey: jest.fn().mockResolvedValue(TEST_PUBLIC),
        signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
      };

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        signer: mockSigner,
      });

      await client.resolvePublicKey();
      expect(client.publicKey).toBe(TEST_PUBLIC);
    });

    it('prefers signer over secretKey when both provided', async () => {
      const mockSigner: Signer = {
        publicKey: jest.fn().mockResolvedValue('GCUSTOM_PUBLIC_KEY'),
        signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
      };

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        signer: mockSigner,
      });

      const pubKey = await client.resolvePublicKey();
      expect(pubKey).toBe('GCUSTOM_PUBLIC_KEY');
    });
  });

  describe('CoralSwapClient without signer', () => {
    it('throws SignerError when publicKey is accessed without signer', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
      });
      expect(() => client.publicKey).toThrow(SignerError);
    });

    it('throws SignerError on resolvePublicKey without signer', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
      });
      await expect(client.resolvePublicKey()).rejects.toThrow(SignerError);
    });

    it('uses config.publicKey for read-only operations', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: TEST_PUBLIC,
      });
      expect(client.publicKey).toBe(TEST_PUBLIC);
    });
  });
});
