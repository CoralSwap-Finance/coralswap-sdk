import { xdr, StrKey, scValToNative } from '@stellar/stellar-sdk';

export interface PairMintEvent {
  type: 'mint';
  contractId: string;
  sender: string;
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
}

export interface PairBurnEvent {
  type: 'burn';
  contractId: string;
  sender: string;
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
  to: string;
}

export interface PairSwapEvent {
  type: 'swap';
  contractId: string;
  sender: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
}

export interface PairSyncEvent {
  type: 'sync';
  contractId: string;
  reserve0: bigint;
  reserve1: bigint;
}

export type PairEvent =
  | PairMintEvent
  | PairBurnEvent
  | PairSwapEvent
  | PairSyncEvent;

function readI128(val: xdr.ScVal): bigint {
  return BigInt(scValToNative(val));
}

function readAddress(val: xdr.ScVal): string {
  return scValToNative(val) as string;
}

function decodeMintData(
  contractId: string,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
): PairMintEvent {
  const fields = data.vec()!;
  return {
    type: 'mint',
    contractId,
    sender: readAddress(topics[1]),
    amount0: readI128(fields[0]),
    amount1: readI128(fields[1]),
    liquidity: readI128(fields[2]),
  };
}

function decodeBurnData(
  contractId: string,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
): PairBurnEvent {
  const fields = data.vec()!;
  return {
    type: 'burn',
    contractId,
    sender: readAddress(topics[1]),
    amount0: readI128(fields[0]),
    amount1: readI128(fields[1]),
    liquidity: readI128(fields[2]),
    to: readAddress(fields[3]),
  };
}

function decodeSwapData(
  contractId: string,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
): PairSwapEvent {
  const fields = data.vec()!;
  return {
    type: 'swap',
    contractId,
    sender: readAddress(topics[1]),
    tokenIn: readAddress(fields[0]),
    tokenOut: readAddress(fields[1]),
    amountIn: readI128(fields[2]),
    amountOut: readI128(fields[3]),
  };
}

function decodeSyncData(
  contractId: string,
  data: xdr.ScVal,
): PairSyncEvent {
  const fields = data.vec()!;
  return {
    type: 'sync',
    contractId,
    reserve0: readI128(fields[0]),
    reserve1: readI128(fields[1]),
  };
}

export function decodePairEvents(
  txMeta: xdr.TransactionMeta,
  pairContractId: string,
): PairEvent[] {
  const results: PairEvent[] = [];

  if (txMeta.switch() !== 3) return results;

  const sorobanMeta = txMeta.v3().sorobanMeta();
  if (!sorobanMeta) return results;

  for (const event of sorobanMeta.events()) {
    const rawId = event.contractId();
    if (!rawId) continue;

    const id = StrKey.encodeContract(rawId);
    if (id !== pairContractId) continue;

    const body = event.body().v0();
    const topics = body.topics();
    const data = body.data();

    if (topics.length === 0) continue;

    const name = scValToNative(topics[0]) as string;

    switch (name) {
      case 'mint':
        results.push(decodeMintData(id, topics, data));
        break;
      case 'burn':
        results.push(decodeBurnData(id, topics, data));
        break;
      case 'swap':
        results.push(decodeSwapData(id, topics, data));
        break;
      case 'sync':
        results.push(decodeSyncData(id, data));
        break;
    }
  }

  return results;
}
