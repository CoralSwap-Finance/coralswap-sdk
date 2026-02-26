import {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import { CoralSwapConfig, NetworkConfig, NETWORK_CONFIGS, DEFAULTS } from '@/config';
import { Network, Result, Logger, Signer } from '@/types/common';
import { SignerError } from '@/errors';
import { FactoryClient } from '@/contracts/factory';
import { PairClient } from '@/contracts/pair';
import { RouterClient } from '@/contracts/router';
import { LPTokenClient } from '@/contracts/lp-token';
import { TokenListModule } from '@/modules/tokens';
import { FactoryModule } from '@/modules/factory';
import { KeypairSigner } from '@/utils/signer';
import { TransactionPoller, PollingStrategy, PollingOptions } from '@/utils/polling';
export { KeypairSigner, PollingStrategy, PollingOptions };

/**
 * Default signer implementation that wraps a Stellar Keypair.
 *
 * Used internally when the client is constructed with a secret key string
 * for backward compatibility.
 */

/**
 * Main entry point for the CoralSwap SDK.
 *
 * Provides a unified interface to all CoralSwap protocol interactions,
 * connecting directly to Soroban RPC without intermediary APIs.
 */
export class CoralSwapClient {
  network: Network;
  config: CoralSwapConfig;
  networkConfig: NetworkConfig;
  server: SorobanRpc.Server;

  private signer: Signer | null = null;
  private _publicKeyCache: string | null = null;
  private _factory: FactoryClient | null = null;
  private _router: RouterClient | null = null;
  private _factoryModule: FactoryModule | null = null;
  private readonly logger?: Logger;

  /**
   * Create a new CoralSwapClient.
   *
   * @param config - SDK configuration. Provide `secretKey` for the built-in
   *   KeypairSigner, or pass a `signer` implementing the {@link Signer}
   *   interface for external wallets (Freighter, Albedo, etc.).
   */
  constructor(config: CoralSwapConfig) {
    this.config = {
      defaultSlippageBps: DEFAULTS.slippageBps,
      defaultDeadlineSec: DEFAULTS.deadlineSec,
      maxRetries: DEFAULTS.maxRetries,
      retryDelayMs: DEFAULTS.retryDelayMs,
      ...config,
    };

    this.network = config.network;
    this.networkConfig = {
      ...NETWORK_CONFIGS[config.network],
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    };

    this.server = new SorobanRpc.Server(this.networkConfig.rpcUrl);

    if (config.signer) {
      this.signer = config.signer;
    } else if (config.secretKey) {
      const kpSigner = new KeypairSigner(
        config.secretKey,
        this.networkConfig.networkPassphrase,
      );
      this.signer = kpSigner;
      this._publicKeyCache = kpSigner.publicKeySync;
    }

    this.logger = config.logger;
  }

  /**
   * Get the transaction poller instance.
   */
  poller(): TransactionPoller {
    if (!this._poller) {
      this._poller = new TransactionPoller(this.server, this.logger);
    }
    return this._poller;
  }

  /**
   * Get the public key of the configured signer.
   *
   * For synchronous access, the key is resolved on first call to
   * {@link resolvePublicKey} and cached. Falls back to config values.
   */
  get publicKey(): string {
    if (this._publicKeyCache) return this._publicKeyCache;
    if (this.config.publicKey) return this.config.publicKey;
    throw new SignerError();
  }

  /**
   * Resolve the public key from the signer asynchronously and cache it.
   *
   * Must be called at least once before using {@link publicKey} when
   * an external signer is provided without an explicit `publicKey` in config.
   */
  async resolvePublicKey(): Promise<string> {
    if (this._publicKeyCache) return this._publicKeyCache;
    if (this.config.publicKey) {
      this._publicKeyCache = this.config.publicKey;
      return this._publicKeyCache;
    }
    if (this.signer) {
      this._publicKeyCache = await this.signer.publicKey();
      return this._publicKeyCache;
    }
    throw new SignerError();
  }

  /**
   * Access the Factory contract client (singleton).
   */
  get factory(): FactoryClient {
    if (!this._factory) {
      if (!this.networkConfig.factoryAddress) {
        throw new Error("Factory address not configured for this network");
      }
      this._factory = new FactoryClient(
        this.networkConfig.factoryAddress,
        this.networkConfig.rpcUrl,
        this.networkConfig.networkPassphrase,
      );
    }
    return this._factory;
  }

  /**
   * Access the Router contract client (singleton).
   */
  get router(): RouterClient {
    if (!this._router) {
      if (!this.networkConfig.routerAddress) {
        throw new Error("Router address not configured for this network");
      }
      this._router = new RouterClient(
        this.networkConfig.routerAddress,
        this.networkConfig.rpcUrl,
        this.networkConfig.networkPassphrase,
      );
    }
    return this._router;
  }

  /**
   * Create a PairClient for a specific pair contract address.
   */
  pair(pairAddress: string): PairClient {
    return new PairClient(
      pairAddress,
      this.networkConfig.rpcUrl,
      this.networkConfig.networkPassphrase,
    );
  }

  /**
   * Switch the client to a different network.
   *
   * @param network - The target network.
   * @param rpcUrl - Optional override for the RPC URL.
   */
  setNetwork(network: Network, rpcUrl?: string): void {
    this.network = network;
    this.networkConfig = {
      ...NETWORK_CONFIGS[network],
      ...(rpcUrl ? { rpcUrl } : {}),
    };

    this.server = new SorobanRpc.Server(this.networkConfig.rpcUrl);

    // Reset contract client singletons to trigger re-initialization
    this._factory = null;
    this._router = null;

    // Reset factory module cache
    if (this._factoryModule) {
      this._factoryModule.clearCache();
    }

    // Refresh signer if using built-in KeypairSigner
    if (this.config.secretKey) {
      const kpSigner = new KeypairSigner(this.config.secretKey, this.networkConfig.networkPassphrase);
      this.signer = kpSigner;
      this._publicKeyCache = kpSigner.publicKeySync;
    }

    this.logger?.info('setNetwork: network switched', {
      network: this.network,
      rpcUrl: this.networkConfig.rpcUrl,
    });
  }

  /**
   * Create an LPTokenClient for a specific LP token contract.
   */
  lpToken(lpTokenAddress: string): LPTokenClient {
    return new LPTokenClient(
      lpTokenAddress,
      this.networkConfig.rpcUrl,
      this.networkConfig.networkPassphrase,
    );
  }

  /**
   * Create a TokenListModule for fetching and validating token lists.
   */
  tokens(): TokenListModule {
    return new TokenListModule(this);
  }

  /**
   * Access the Factory module (cached lookups).
   */
  factoryModule(): FactoryModule {
    if (!this._factoryModule) {
      this._factoryModule = new FactoryModule(this);
    }
    return this._factoryModule;
  }

  /**
   * Lookup the pair address for a token pair via the factory.
   */
  async getPairAddress(tokenA: string, tokenB: string): Promise<string | null> {
    return this.factoryModule().getPairAddress(tokenA, tokenB);
  }

  /**
   * Build, simulate, sign and submit a transaction.
   */
  async submitTransaction(
    operations: xdr.Operation[],
    source?: string,
  ): Promise<Result<{ txHash: string; ledger: number }>> {
    try {
      const sourceKey = source ?? (await this.resolvePublicKey());

      this.logger?.debug("getAccount: fetching account", { sourceKey });
      const account = await this.server.getAccount(sourceKey);
      this.logger?.debug("getAccount: success", { sourceKey });

      let builder = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: this.networkConfig.networkPassphrase,
      });

      for (const op of operations) {
        builder = builder.addOperation(op);
      }

      const tx = builder.setTimeout(this.networkConfig.sorobanTimeout).build();

      this.logger?.debug("simulateTransaction: simulating", {
        sourceKey,
        operationCount: operations.length,
      });
      const sim = await this.server.simulateTransaction(tx);
      if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
        this.logger?.error("simulateTransaction: simulation failed", {
          simulation: sim,
        });
        return {
          success: false,
          error: {
            code: "SIMULATION_FAILED",
            message: "Transaction simulation failed",
            details: { simulation: sim },
          },
        };
      }
      this.logger?.debug("simulateTransaction: success");

      const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();

      if (!this.signer) {
        return {
          success: false,
          error: {
            code: "NO_SIGNER",
            message:
              "No signing key configured. Provide secretKey or a Signer instance.",
          },
        };
      }

      const signedXdr = await this.signer.signTransaction(preparedTx.toXDR());
      const signedTx = new Transaction(
        signedXdr,
        this.networkConfig.networkPassphrase,
      );

      const response = await this.server.sendTransaction(signedTx);

      if (response.status === "ERROR") {
        this.logger?.error("sendTransaction: submission failed", { response });
        return {
          success: false,
          error: {
            code: "SUBMIT_FAILED",
            message: "Transaction submission failed",
            details: { response },
          },
        };
      }

      this.logger?.info("sendTransaction: submitted", {
        txHash: response.hash,
      });
      const result = await this.pollTransaction(response.hash);
      return result;
    } catch (err) {
      this.logger?.error("submitTransaction: unexpected error", err);
      return {
        success: false,
        error: {
          code: "UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
          details: { error: err },
        },
      };
    }
  }

  /**
   * Poll for transaction confirmation using the customized poller.
   */
  private async pollTransaction(
    txHash: string,
  ): Promise<Result<{ txHash: string; ledger: number }>> {
    return this.poller().poll(txHash, {
      strategy: this.config.pollingStrategy ?? DEFAULTS.pollingStrategy,
      interval: this.config.pollingIntervalMs ?? DEFAULTS.pollingIntervalMs,
      maxAttempts: this.config.maxPollingAttempts ?? DEFAULTS.maxPollingAttempts,
      backoffFactor: this.config.pollingBackoffFactor ?? DEFAULTS.pollingBackoffFactor,
      maxInterval: this.config.maxPollingIntervalMs ?? DEFAULTS.maxPollingIntervalMs,
    });
  }

  /**
   * Simulate a transaction without submitting (dry-run).
   */
  async simulateTransaction(
    operations: xdr.Operation[],
    source?: string,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    const sourceKey = source ?? this.publicKey;

    this.logger?.debug("simulateTransaction (dry-run): fetching account", {
      sourceKey,
    });
    const account = await this.server.getAccount(sourceKey);

    let builder = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkConfig.networkPassphrase,
    });

    for (const op of operations) {
      builder = builder.addOperation(op);
    }

    const tx = builder.setTimeout(30).build();

    this.logger?.debug("simulateTransaction (dry-run): simulating", {
      sourceKey,
      operationCount: operations.length,
    });
    const sim = await this.server.simulateTransaction(tx);
    this.logger?.debug("simulateTransaction (dry-run): completed");
    return sim;
  }

  /**
   * Calculate a deadline timestamp (current ledger time + offset seconds).
   */
  getDeadline(offsetSec?: number): number {
    const offset =
      offsetSec ?? this.config.defaultDeadlineSec ?? DEFAULTS.deadlineSec;
    return Math.floor(Date.now() / 1000) + offset;
  }

  /**
   * Health check -- verify RPC connection.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.server.getHealth();
      return health.status === "healthy";
    } catch {
      return false;
    }
  }

  /**
   * Get the current ledger number from the RPC.
   */
  async getCurrentLedger(): Promise<number> {
    const info = await this.server.getLatestLedger();
    return info.sequence;
  }
}
