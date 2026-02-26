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
     * @param network - The target network (TESTNET, MAINNET).
     * @param rpcUrl - Optional custom RPC endpoint.
     */
    async switchNetwork(network: Network, rpcUrl?: string): Promise<void> {
        this.client.setNetwork(network, rpcUrl);

        // If we have an external signer, we might need to verify its health 
        // or re-resolve the public key for the new network environment.
        await this.client.resolvePublicKey();
    }

    /**
     * Get the current network status.
     */
    get currentNetwork(): Network {
        return this.client.network;
    }
}
