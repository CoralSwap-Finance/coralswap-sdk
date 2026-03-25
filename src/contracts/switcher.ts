import { CoralSwapClient } from '@/client';
import { Network } from '@/types/common';

/**
 * Utility for switching networks across the CoralSwap protocol.
 *
 * Provides a formal wrapper around the client's network switching
 * capabilities, ensuring all connected components are re-aligned.
 */
export class NetworkSwitcher {
    private client: CoralSwapClient;

    constructor(client: CoralSwapClient) {
        this.client = client;
    }

    /**
     * Switch the entire SDK context to a new network.
     *
     * Re-initialises the RPC server, contract client singletons, and signer
     * for the target network. Also resolves and caches the public key for the
     * new network environment.
     *
     * @param network - The target network (TESTNET, MAINNET).
     * @param rpcUrl - Optional custom RPC endpoint override.
     * @returns Resolves when the network switch and key resolution are complete.
     */
    async switchNetwork(network: Network, rpcUrl?: string): Promise<void> {
        this.client.setNetwork(network, rpcUrl);

        // If we have an external signer, we might need to verify its health 
        // or re-resolve the public key for the new network environment.
        await this.client.resolvePublicKey();
    }

    /**
     * Get the current network the client is connected to.
     *
     * @returns The active {@link Network} value.
     */
    get currentNetwork(): Network {
        return this.client.network;
    }
}
