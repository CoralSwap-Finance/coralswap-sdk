import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { RedStonePayload } from '../../src/types/swap';

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 0x5a),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey);

export function makeSignedRedstonePayload(
  prices: Record<string, bigint>,
  timestampMs = Date.now(),
): RedStonePayload {
  const body = Buffer.from(
    JSON.stringify({ timestampMs, prices: Object.fromEntries(
      Object.entries(prices).map(([symbol, price]) => [symbol, price.toString()]),
    ) }),
  );
  const signature = sign(null, body, privateKey);
  return {
    data: Buffer.from(JSON.stringify({ body: body.toString('base64'), signature: signature.toString('base64') })),
    timestampMs,
    prices,
  };
}

export function hasValidFixtureSignature(payload: RedStonePayload): boolean {
  try {
    const envelope = JSON.parse(Buffer.from(payload.data).toString('utf8')) as {
      body: string;
      signature: string;
    };
    return verify(
      null,
      Buffer.from(envelope.body, 'base64'),
      publicKey,
      Buffer.from(envelope.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
