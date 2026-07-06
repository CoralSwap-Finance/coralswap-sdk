import { Account, FeeBumpTransaction, Transaction, xdr, SorobanRpc } from '@stellar/stellar-sdk';
import { MockProvider } from '../src/test/mocks/MockProvider';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MockProvider wrapper that injects a fixed per-call latency on RPC methods.
 *
 * Fixed delays keep benchmark variance within the ±10 % target in CI while
 * still exercising the real SDK → RPC call path.
 */
export class LatencyMockProvider extends MockProvider {
  constructor(private readonly latencyMs: number) {
    super();
  }

  private async withLatency<T>(fn: () => Promise<T>): Promise<T> {
    if (this.latencyMs > 0) {
      await sleep(this.latencyMs);
    }
    return fn();
  }

  override async getAccount(address: string): Promise<Account> {
    return this.withLatency(() => super.getAccount(address));
  }

  override async getHealth(): Promise<SorobanRpc.Api.GetHealthResponse> {
    return this.withLatency(() => super.getHealth());
  }

  override async getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<SorobanRpc.Api.GetLedgerEntriesResponse> {
    return this.withLatency(() => super.getLedgerEntries(...keys));
  }

  override async sendTransaction(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    return this.withLatency(() => super.sendTransaction(transaction));
  }

  override async getTransaction(
    hash: string,
  ): Promise<SorobanRpc.Api.GetTransactionResponse> {
    return this.withLatency(() => super.getTransaction(hash));
  }

  override async getLatestLedger(): Promise<SorobanRpc.Api.GetLatestLedgerResponse> {
    return this.withLatency(() => super.getLatestLedger());
  }

  override async simulateTransaction(
    tx: Transaction | FeeBumpTransaction,
    addlResources?: SorobanRpc.Server.ResourceLeeway,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.withLatency(() => super.simulateTransaction(tx, addlResources));
  }
}
