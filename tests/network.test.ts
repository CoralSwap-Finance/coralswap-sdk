import { Keypair, SorobanRpc } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { NetworkSwitcher } from '../src/contracts/switcher';
import { Network } from '../src/types/common';
import { NETWORK_CONFIGS } from '../src/config';

// Mock SorobanRpc.Server
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        SorobanRpc: {
            ...actual.SorobanRpc,
            Server: jest.fn().mockImplementation((rpcUrl) => ({
                rpcUrl,
                getAccount: jest.fn(),
                simulateTransaction: jest.fn(),
                sendTransaction: jest.fn(),
                getTransaction: jest.fn(),
            })),
        },
    };
});

describe('Network Switching', () => {
    const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';

    it('CoralSwapClient.setNetwork updates configuration correctly', () => {
        const client = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: TEST_SECRET,
        });

        expect(client.network).toBe(Network.TESTNET);
        expect(client.networkConfig.networkPassphrase).toBe(NETWORK_CONFIGS[Network.TESTNET].networkPassphrase);
        const initialServer = client.server;

        // Switch to Mainnet
        client.setNetwork(Network.MAINNET);

        expect(client.network).toBe(Network.MAINNET);
        expect(client.networkConfig.networkPassphrase).toBe(NETWORK_CONFIGS[Network.MAINNET].networkPassphrase);
        expect(client.server).not.toBe(initialServer);
        expect((client.server as any).rpcUrl).toBe(NETWORK_CONFIGS[Network.MAINNET].rpcUrl);
    });

    it('CoralSwapClient.setNetwork resets contract singletons', () => {
        const client = new CoralSwapClient({
            network: Network.TESTNET,
            // Need factoryAddress in config for TESTNET if it's empty in config.ts, 
            // but let's assume it's empty and we check if the cache is cleared.
        });

        // Mock factoryAddress if needed - use a valid Stellar contract address format
        (client as any).networkConfig.factoryAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

        const factory1 = client.factory;
        expect(factory1).toBeDefined();

        client.setNetwork(Network.MAINNET);

        // After reset, checking if the private field is null would be best, 
        // but we can check if a new access creates a new instance.
        // However, since we can't easily check private fields in TS tests without casting,
        // let's just verify properties of the new client are updated if we had different addresses.

        (client as any).networkConfig.factoryAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
        const factory2 = client.factory;
        expect(factory2).not.toBe(factory1);
    });

    it('NetworkSwitcher wraps client.setNetwork correctly', async () => {
        const client = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: TEST_SECRET,
        });

        const switcher = new NetworkSwitcher(client);

        // Mock resolvePublicKey to avoid errors
        client.resolvePublicKey = jest.fn().mockResolvedValue('test-pubkey');

        await switcher.switchNetwork(Network.MAINNET);

        expect(client.network).toBe(Network.MAINNET);
        expect(client.resolvePublicKey).toHaveBeenCalled();
    });

    it('supports custom RPC URL during network switch', () => {
        const client = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: TEST_SECRET,
        });

        const customRpc = 'https://my-custom-rpc.com';
        client.setNetwork(Network.MAINNET, customRpc);

        expect(client.network).toBe(Network.MAINNET);
        expect(client.networkConfig.rpcUrl).toBe(customRpc);
        expect((client.server as any).rpcUrl).toBe(customRpc);
    });
});
