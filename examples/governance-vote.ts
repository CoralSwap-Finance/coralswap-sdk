import 'dotenv/config';
import { Address, Contract, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import {
  CoralSwapSDKError,
  SimulationError,
  TransactionError,
  ValidationError,
} from '../src/errors';
import { Network } from '../src/types/common';
import type { SimulateTransactionResult } from '../src/types/common';

const DEFAULT_CREATE_METHOD = 'create_proposal';
const DEFAULT_STATUS_METHOD = 'get_proposal_status';
const DEFAULT_VOTE_METHOD = 'cast_vote';
const DEFAULT_QUORUM_METHOD = 'get_quorum_status';
const DEFAULT_EXECUTE_METHOD = 'execute_proposal';

export function parseGovernanceArgs(rawArgs?: string): unknown[] {
  if (!rawArgs) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawArgs);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseGovernanceValue(value: unknown): xdr.ScVal {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const typedValue = value as { type?: string; value?: unknown };
    switch (typedValue.type) {
      case 'address':
        return Address.fromString(String(typedValue.value)).toScVal();
      case 'string':
        return nativeToScVal(String(typedValue.value));
      case 'bool':
        return nativeToScVal(Boolean(typedValue.value));
      case 'u64':
      case 'i64':
      case 'u128':
      case 'i128':
      case 'u32':
      case 'i32':
      default:
        return nativeToScVal(typedValue.value as never);
    }
  }

  if (typeof value === 'string' && value.startsWith('G') && value.length >= 56) {
    return Address.fromString(value).toScVal();
  }

  if (typeof value === 'bigint') {
    return nativeToScVal(value);
  }

  return nativeToScVal(value as never);
}

function createContractCallArgs(rawArgs?: string): xdr.ScVal[] {
  return parseGovernanceArgs(rawArgs).map((arg) => parseGovernanceValue(arg));
}

function prependProposalId(args: xdr.ScVal[], proposalId: string): xdr.ScVal[] {
  const proposalArg = parseGovernanceValue(proposalId);
  return args.length > 0 ? [proposalArg, ...args] : [proposalArg];
}

function formatScValue(value: xdr.ScVal | null): string {
  if (!value) {
    return 'N/A';
  }

  try {
    const nativeValue = scValToNative(value);
    return JSON.stringify(nativeValue);
  } catch {
    return value.toString();
  }
}

async function simulateAndReport(
  client: CoralSwapClient,
  operation: xdr.Operation,
  source: string,
  label: string,
): Promise<SimulateTransactionResult> {
  const result = await client.simulateTransaction([operation], {
    source,
    timeoutSec: 60,
  });

  if (!result.success) {
    throw new SimulationError(`${label} failed: ${result.error ?? 'Unknown simulation failure'}`, {
      label,
      error: result.error,
    });
  }

  console.log(`${label} simulation succeeded.`);
  return result;
}

async function submitAndReport(
  client: CoralSwapClient,
  operation: xdr.Operation,
  source: string,
  label: string,
): Promise<{ txHash: string; ledger: number }> {
  const submission = await client.submitTransaction([operation], source);

  if (!submission.success) {
    throw new TransactionError(`${label} submission failed`, undefined, {
      label,
      error: submission.error,
    });
  }

  if (!submission.data) {
    throw new TransactionError(`${label} submission succeeded but no payload was returned`, undefined, {
      label,
    });
  }

  console.log(`${label} submitted successfully.`);
  return submission.data;
}

async function main(): Promise<void> {
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const governanceContractAddress = process.env.CORALSWAP_GOVERNANCE_CONTRACT;
  const createMethod = process.env.CORALSWAP_GOVERNANCE_CREATE_METHOD ?? DEFAULT_CREATE_METHOD;
  const statusMethod = process.env.CORALSWAP_GOVERNANCE_STATUS_METHOD ?? DEFAULT_STATUS_METHOD;
  const voteMethod = process.env.CORALSWAP_GOVERNANCE_VOTE_METHOD ?? DEFAULT_VOTE_METHOD;
  const quorumMethod = process.env.CORALSWAP_GOVERNANCE_QUORUM_METHOD ?? DEFAULT_QUORUM_METHOD;
  const executeMethod = process.env.CORALSWAP_GOVERNANCE_EXECUTE_METHOD ?? DEFAULT_EXECUTE_METHOD;
  const proposalArgsJson = process.env.CORALSWAP_GOVERNANCE_PROPOSAL_ARGS_JSON;
  const voteArgsJson = process.env.CORALSWAP_GOVERNANCE_VOTE_ARGS_JSON;
  const executeArgsJson = process.env.CORALSWAP_GOVERNANCE_EXECUTE_ARGS_JSON;
  const quorumThreshold = Number(process.env.CORALSWAP_GOVERNANCE_QUORUM_THRESHOLD ?? '0');
  const votingPeriodSeconds = Number(process.env.CORALSWAP_GOVERNANCE_VOTING_PERIOD_SECONDS ?? '604800');
  const proposalId = process.env.CORALSWAP_GOVERNANCE_PROPOSAL_ID;

  if (!secretKey || !publicKey || !governanceContractAddress) {
    throw new ValidationError(
      'Missing required environment variables. Set CORALSWAP_SECRET_KEY, CORALSWAP_PUBLIC_KEY, and CORALSWAP_GOVERNANCE_CONTRACT before running this example.',
      {
        rpcUrl,
        network: networkEnv,
      },
    );
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;
  const client = new CoralSwapClient({
    network,
    rpcUrl,
    secretKey,
    publicKey,
  });

  const contract = new Contract(governanceContractAddress);
  const proposalArgs = createContractCallArgs(proposalArgsJson);
  const voteArgs = createContractCallArgs(voteArgsJson);
  const executeArgs = createContractCallArgs(executeArgsJson);

  console.log('Governance proposal lifecycle example');
  console.log(`Network: ${networkEnv}`);
  console.log(`Governance contract: ${governanceContractAddress}`);
  console.log(`Quorum threshold: ${quorumThreshold}`);
  console.log(`Voting period: ${votingPeriodSeconds} seconds (${votingPeriodSeconds / 86400} days)`);
  console.log('');

  // Step 1: create a proposal with the configured governance contract method.
  // The example keeps the method names and argument payload configurable so it can
  // target a deployed testnet governance contract without being hard-coded to one ABI.
  const createOperation = contract.call(createMethod, ...proposalArgs);
  const createSimulation = await simulateAndReport(
    client,
    createOperation,
    publicKey,
    'Create proposal',
  );

  const resolvedProposalId = proposalId ?? formatScValue(createSimulation.returnValue);
  console.log(`Proposal identifier: ${resolvedProposalId}`);

  const createResult = await submitAndReport(
    client,
    createOperation,
    publicKey,
    'Create proposal',
  );
  console.log(`Create proposal transaction hash: ${createResult.txHash}`);
  console.log('');

  // Step 2: query the current proposal status from the governance contract.
  // Most governance contracts expose a status or proposal lookup function that can be
  // invoked again using the created proposal identifier.
  const statusOperation = contract.call(statusMethod, ...createContractCallArgs(JSON.stringify([resolvedProposalId])));
  const statusSimulation = await simulateAndReport(
    client,
    statusOperation,
    publicKey,
    'Query proposal status',
  );
  console.log(`Proposal status: ${formatScValue(statusSimulation.returnValue)}`);
  console.log('');

  // Step 3: cast a vote for the proposal.
  // The vote payload is configurable because different deployments use different
  // argument layouts (for example: proposal_id + support, or proposal_id + voter + choice).
  const voteOperation = contract.call(voteMethod, ...prependProposalId(voteArgs, resolvedProposalId));
  const voteSimulation = await simulateAndReport(
    client,
    voteOperation,
    publicKey,
    'Cast vote',
  );
  console.log(`Vote return value: ${formatScValue(voteSimulation.returnValue)}`);
  const voteResult = await submitAndReport(client, voteOperation, publicKey, 'Cast vote');
  console.log(`Vote transaction hash: ${voteResult.txHash}`);
  console.log('');

  // Step 4: inspect quorum metrics before execution.
  // Quorum thresholds are usually expressed as a percentage or absolute voting power.
  // The script surfaces that value from the environment so builders can tune it per deployment.
  const quorumOperation = contract.call(quorumMethod, ...createContractCallArgs(JSON.stringify([resolvedProposalId])));
  const quorumSimulation = await simulateAndReport(
    client,
    quorumOperation,
    publicKey,
    'Check quorum',
  );
  console.log(`Quorum status: ${formatScValue(quorumSimulation.returnValue)}`);
  console.log(`Configured quorum threshold: ${quorumThreshold}`);
  console.log('');

  // Step 5: execute the proposal after it has passed and reached quorum.
  // Some governance contracts also require an execution delay to elapse; this example
  // leaves the delay handling to the contract and focuses on the lifecycle flow.
  const executeOperation = contract.call(executeMethod, ...prependProposalId(executeArgs, resolvedProposalId));
  const executeSimulation = await simulateAndReport(
    client,
    executeOperation,
    publicKey,
    'Execute proposal',
  );
  console.log(`Execution return value: ${formatScValue(executeSimulation.returnValue)}`);
  const executeResult = await submitAndReport(client, executeOperation, publicKey, 'Execute proposal');
  console.log(`Execution transaction hash: ${executeResult.txHash}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof CoralSwapSDKError) {
      console.error(`Governance example failed with typed error ${error.name} [${error.code}]:`, error.message);
      if (error.details) {
        console.error('Details:', error.details);
      }
    } else {
      console.error('Governance example failed:', error);
    }

    process.exit(1);
  });
}
