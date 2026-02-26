/**
 * Advanced Flash Loan Patterns and Use Cases
 * 
 * This example demonstrates advanced flash loan patterns and use cases for
 * building sophisticated DeFi applications with CoralSwap. It covers complex
 * scenarios like arbitrage, liquidation, and collateral swaps.
 * 
 * Topics Covered:
 * - Reading flash loan configuration
 * - Checking maximum borrowable amounts
 * - Arbitrage patterns (multi-DEX swaps)
 * - Liquidation patterns (underwater positions)
 * - Collateral swap patterns (debt refinancing)
 * - Multi-token operations within callbacks
 * - Advanced error handling
 * - Transaction building patterns
 * - Best practices for complex integrations
 * 
 * Prerequisites:
 * - Understanding of basic flash loan concepts (see flash-loan-basic.ts)
 * - Knowledge of flash receiver implementation (see flash-loan-receiver-guide.ts)
 * - Familiarity with DeFi concepts (arbitrage, liquidation, etc.)
 * - Environment variables configured (see .env.example)
 */

import 'dotenv/config';
import { Network } from '../src/types/common';
import { CoralSwapClient } from '../src/client';
import { FlashLoanModule } from '../src/modules/flash-loan';
import { encodeFlashLoanData } from '../src/contracts/flash-receiver';
import { FlashLoanError, TransactionError } from '../src/errors';

async function main() {
  // ============================================================================
  // Environment Configuration
  // ============================================================================
  
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const pairAddress = process.env.CORALSWAP_PAIR_ADDRESS;
  const flashToken = process.env.CORALSWAP_FLASH_TOKEN;
  const flashAmountStr = process.env.CORALSWAP_FLASH_AMOUNT;
  const flashReceiver = process.env.CORALSWAP_FLASH_RECEIVER;

  if (!rpcUrl || !secretKey || !publicKey || !pairAddress || !flashToken || !flashAmountStr || !flashReceiver) {
    console.error('❌ Missing required environment variables.');
    console.error('Please ensure all CORALSWAP_* variables are set in your .env file.');
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;
  const flashAmount = BigInt(flashAmountStr);

  console.log('🚀 Advanced Flash Loan Patterns');
  console.log('='.repeat(70));
  console.log('');

  // ============================================================================
  // Initialize SDK Client and Flash Loan Module
  // ============================================================================
  
  const client = new CoralSwapClient({
    network,
    rpcUrl,
    secretKey,
    publicKey,
  });

  const flashLoanModule = new FlashLoanModule(client);

  try {
    // ==========================================================================
    // STEP 1: Read Flash Loan Configuration
    // ==========================================================================
    // Before executing flash loans, it's good practice to read and display
    // the pair's flash loan configuration. This helps you understand:
    // - The fee structure (feeBps and feeFloor)
    // - Whether flash loans are currently enabled (locked status)
    // - Any protocol-level constraints
    
    console.log('📋 Reading Flash Loan Configuration');
    console.log('-'.repeat(70));
    
    const config = await flashLoanModule.getConfig(pairAddress);
    
    console.log(`  Fee Rate: ${config.flashFeeBps} bps (${(config.flashFeeBps / 100).toFixed(2)}%)`);
    console.log(`  Fee Floor: ${config.flashFeeFloor} units (minimum fee)`);
    console.log(`  Status: ${config.locked ? '🔒 Locked (Disabled)' : '✅ Unlocked (Enabled)'}`);
    console.log('');
    
    if (config.locked) {
      console.error('❌ Flash loans are currently disabled for this pair.');
      console.error('   The pair administrator has locked flash loan functionality.');
      process.exit(1);
    }
    
    console.log('💡 Fee Structure Explanation:');
    console.log('   - Fee is calculated as: (amount * feeBps) / 10000');
    console.log('   - If calculated fee < feeFloor, the feeFloor is used');
    console.log('   - This prevents dust attacks on small amounts');
    console.log('');

    // ==========================================================================
    // STEP 2: Check Maximum Borrowable Amount
    // ==========================================================================
    // The getMaxBorrowable() method returns the maximum amount you can borrow
    // for a specific token. This is useful for:
    // - UI display (showing users the max they can borrow)
    // - Validation (ensuring requested amount is available)
    // - Strategy planning (knowing liquidity constraints)
    //
    // IMPORTANT: The returned value includes a 1% safety margin to account for
    // potential reserve changes between the check and execution. This prevents
    // edge cases where reserves decrease slightly before your transaction executes.
    
    console.log('💰 Checking Maximum Borrowable Amount');
    console.log('-'.repeat(70));
    
    const maxBorrowable = await flashLoanModule.getMaxBorrowable(
      pairAddress,
      flashToken
    );
    
    console.log(`  Token: ${flashToken}`);
    console.log(`  Max Borrowable: ${maxBorrowable.toString()} units`);
    console.log(`  Requested Amount: ${flashAmount.toString()} units`);
    console.log('');
    
    if (flashAmount > maxBorrowable) {
      console.error('❌ Requested amount exceeds maximum borrowable amount.');
      console.error(`   Max: ${maxBorrowable.toString()}, Requested: ${flashAmount.toString()}`);
      console.error('');
      console.error('💡 This could mean:');
      console.error('   - Insufficient reserves in the pair');
      console.error('   - Try a smaller amount');
      console.error('   - Wait for more liquidity to be added');
      process.exit(1);
    }
    
    console.log('✅ Requested amount is within borrowable limits');
    console.log('');
    console.log('💡 Safety Margin:');
    console.log('   getMaxBorrowable() returns reserve - 1% to prevent edge cases');
    console.log('   where reserves change between check and execution.');
    console.log('');

    // ==========================================================================
    // ADVANCED USE CASE PATTERNS
    // ==========================================================================
    // Flash loans enable several powerful DeFi patterns. Below are the most
    // common use cases with explanations of how they work.
    
    console.log('📚 Common Flash Loan Use Cases');
    console.log('='.repeat(70));
    console.log('');

    // --------------------------------------------------------------------------
    // USE CASE 1: ARBITRAGE
    // --------------------------------------------------------------------------
    // Arbitrage exploits price differences between different DEXes or markets.
    //
    // Flow:
    // 1. Borrow token A from CoralSwap
    // 2. Swap token A for token B on DEX 1 (where A is cheaper)
    // 3. Swap token B for token A on DEX 2 (where A is more expensive)
    // 4. Repay borrowed token A + fee
    // 5. Keep the profit
    //
    // Requirements:
    // - Price difference must be larger than fees + slippage
    // - Both swaps must execute successfully
    // - Must end with enough token A to repay + fee
    
    console.log('1️⃣  ARBITRAGE PATTERN');
    console.log('-'.repeat(70));
    console.log('');
    console.log('   Concept: Exploit price differences between DEXes');
    console.log('');
    console.log('   Flow:');
    console.log('   ┌─────────────────────────────────────────────────────────┐');
    console.log('   │ 1. Borrow 1000 USDC from CoralSwap                     │');
    console.log('   │ 2. Swap 1000 USDC → 0.5 ETH on DEX A (cheaper)         │');
    console.log('   │ 3. Swap 0.5 ETH → 1050 USDC on DEX B (more expensive)  │');
    console.log('   │ 4. Repay 1000 USDC + 0.9 USDC fee = 1000.9 USDC        │');
    console.log('   │ 5. Profit: 1050 - 1000.9 = 49.1 USDC                   │');
    console.log('   └─────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('   Callback Data Structure:');
    
    const arbitrageData = encodeFlashLoanData({
      operation: 'arbitrage',
      dexA: 'CDEX_A_CONTRACT_ADDRESS',
      dexB: 'CDEX_B_CONTRACT_ADDRESS',
      intermediateToken: 'CETH_TOKEN_ADDRESS',
      minProfit: '1000000', // Minimum profit in stroops
      slippageTolerance: 100, // 1% slippage tolerance
    });
    
    console.log('   {');
    console.log('     operation: "arbitrage",');
    console.log('     dexA: "CDEX_A_CONTRACT_ADDRESS",');
    console.log('     dexB: "CDEX_B_CONTRACT_ADDRESS",');
    console.log('     intermediateToken: "CETH_TOKEN_ADDRESS",');
    console.log('     minProfit: "1000000",');
    console.log('     slippageTolerance: 100');
    console.log('   }');
    console.log('');
    console.log('   ⚠️  Risks:');
    console.log('   - Price may change between simulation and execution');
    console.log('   - Slippage may eat into profits');
    console.log('   - Gas/fees may exceed profit');
    console.log('   - MEV bots may front-run your transaction');
    console.log('');

    // --------------------------------------------------------------------------
    // USE CASE 2: LIQUIDATION
    // --------------------------------------------------------------------------
    // Liquidation allows you to liquidate underwater positions in lending
    // protocols without having the collateral upfront.
    //
    // Flow:
    // 1. Borrow token A (the debt token) from CoralSwap
    // 2. Repay the underwater position's debt with token A
    // 3. Receive collateral token B (at a discount)
    // 4. Swap token B for token A (if needed)
    // 5. Repay borrowed token A + fee
    // 6. Keep the profit (liquidation bonus - fees)
    
    console.log('2️⃣  LIQUIDATION PATTERN');
    console.log('-'.repeat(70));
    console.log('');
    console.log('   Concept: Liquidate underwater positions without upfront capital');
    console.log('');
    console.log('   Flow:');
    console.log('   ┌─────────────────────────────────────────────────────────┐');
    console.log('   │ 1. Borrow 1000 USDC from CoralSwap                     │');
    console.log('   │ 2. Repay underwater position\'s 1000 USDC debt          │');
    console.log('   │ 3. Receive 0.6 ETH collateral (with 10% bonus)         │');
    console.log('   │ 4. Swap 0.6 ETH → 1100 USDC                            │');
    console.log('   │ 5. Repay 1000 USDC + 0.9 USDC fee = 1000.9 USDC        │');
    console.log('   │ 6. Profit: 1100 - 1000.9 = 99.1 USDC                   │');
    console.log('   └─────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('   Callback Data Structure:');
    
    const liquidationData = encodeFlashLoanData({
      operation: 'liquidation',
      lendingProtocol: 'CLENDING_PROTOCOL_ADDRESS',
      targetPosition: 'CPOSITION_ADDRESS',
      collateralToken: 'CETH_TOKEN_ADDRESS',
      debtToken: 'CUSDC_TOKEN_ADDRESS',
      minProfit: '5000000',
    });
    
    console.log('   {');
    console.log('     operation: "liquidation",');
    console.log('     lendingProtocol: "CLENDING_PROTOCOL_ADDRESS",');
    console.log('     targetPosition: "CPOSITION_ADDRESS",');
    console.log('     collateralToken: "CETH_TOKEN_ADDRESS",');
    console.log('     debtToken: "CUSDC_TOKEN_ADDRESS",');
    console.log('     minProfit: "5000000"');
    console.log('   }');
    console.log('');
    console.log('   ⚠️  Risks:');
    console.log('   - Position may be liquidated by someone else first');
    console.log('   - Collateral price may drop during execution');
    console.log('   - Liquidation bonus may not cover fees + slippage');
    console.log('');

    // --------------------------------------------------------------------------
    // USE CASE 3: COLLATERAL SWAP
    // --------------------------------------------------------------------------
    // Collateral swap allows you to change your collateral type in a lending
    // protocol without closing your position.
    //
    // Flow:
    // 1. Borrow token A (your current debt) from CoralSwap
    // 2. Repay your debt in the lending protocol
    // 3. Withdraw your collateral token B
    // 4. Swap token B for token C (new collateral)
    // 5. Deposit token C as new collateral
    // 6. Borrow token A again from lending protocol
    // 7. Repay flash loan with borrowed token A + fee
    
    console.log('3️⃣  COLLATERAL SWAP PATTERN');
    console.log('-'.repeat(70));
    console.log('');
    console.log('   Concept: Change collateral type without closing position');
    console.log('');
    console.log('   Flow:');
    console.log('   ┌─────────────────────────────────────────────────────────┐');
    console.log('   │ 1. Borrow 1000 USDC from CoralSwap                     │');
    console.log('   │ 2. Repay 1000 USDC debt in lending protocol            │');
    console.log('   │ 3. Withdraw 0.5 ETH collateral                         │');
    console.log('   │ 4. Swap 0.5 ETH → 2000 USDT                            │');
    console.log('   │ 5. Deposit 2000 USDT as new collateral                 │');
    console.log('   │ 6. Borrow 1001 USDC from lending protocol              │');
    console.log('   │ 7. Repay 1000 USDC + 0.9 USDC fee = 1000.9 USDC        │');
    console.log('   └─────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('   Callback Data Structure:');
    
    const collateralSwapData = encodeFlashLoanData({
      operation: 'collateral_swap',
      lendingProtocol: 'CLENDING_PROTOCOL_ADDRESS',
      oldCollateralToken: 'CETH_TOKEN_ADDRESS',
      newCollateralToken: 'CUSDT_TOKEN_ADDRESS',
      debtToken: 'CUSDC_TOKEN_ADDRESS',
      swapPath: ['CETH_TOKEN_ADDRESS', 'CUSDT_TOKEN_ADDRESS'],
      slippageTolerance: 100,
    });
    
    console.log('   {');
    console.log('     operation: "collateral_swap",');
    console.log('     lendingProtocol: "CLENDING_PROTOCOL_ADDRESS",');
    console.log('     oldCollateralToken: "CETH_TOKEN_ADDRESS",');
    console.log('     newCollateralToken: "CUSDT_TOKEN_ADDRESS",');
    console.log('     debtToken: "CUSDC_TOKEN_ADDRESS",');
    console.log('     swapPath: ["CETH", "CUSDT"],');
    console.log('     slippageTolerance: 100');
    console.log('   }');
    console.log('');
    console.log('   ⚠️  Risks:');
    console.log('   - Swap slippage may result in insufficient new collateral');
    console.log('   - New collateral may have different LTV requirements');
    console.log('   - May not be able to borrow enough to repay flash loan');
    console.log('');

    // ==========================================================================
    // MULTI-TOKEN OPERATIONS
    // ==========================================================================
    // Flash loans can involve multiple tokens and complex swap paths.
    // Your receiver contract must handle:
    // - Multiple token approvals
    // - Multi-hop swaps (A → B → C → A)
    // - Tracking balances across operations
    // - Ensuring sufficient final balance for repayment
    
    console.log('🔄 Multi-Token Operations');
    console.log('='.repeat(70));
    console.log('');
    console.log('   When performing complex operations with multiple tokens:');
    console.log('');
    console.log('   1. Track Token Balances');
    console.log('      - Check balance before each operation');
    console.log('      - Verify expected output amounts');
    console.log('      - Ensure sufficient balance for repayment');
    console.log('');
    console.log('   2. Handle Token Approvals');
    console.log('      - Approve each DEX/protocol for token transfers');
    console.log('      - Consider using max approval for gas efficiency');
    console.log('      - Revoke approvals after operations (optional)');
    console.log('');
    console.log('   3. Multi-Hop Swap Example');
    console.log('      Path: USDC → ETH → BTC → USDC');
    console.log('      - Swap 1: USDC → ETH on DEX A');
    console.log('      - Swap 2: ETH → BTC on DEX B');
    console.log('      - Swap 3: BTC → USDC on DEX C');
    console.log('      - Must end with more USDC than borrowed + fee');
    console.log('');
    console.log('   4. Slippage Protection');
    console.log('      - Set minimum output for each swap');
    console.log('      - Account for cumulative slippage');
    console.log('      - Revert if final amount insufficient');
    console.log('');

    // ==========================================================================
    // ATOMIC EXECUTION AND TIMING CONSTRAINTS
    // ==========================================================================
    
    console.log('⏱️  Atomic Execution and Timing');
    console.log('='.repeat(70));
    console.log('');
    console.log('   Flash loans are ATOMIC - everything happens in one transaction:');
    console.log('');
    console.log('   ✅ Advantages:');
    console.log('   - No capital required upfront');
    console.log('   - No liquidation risk (can\'t be liquidated mid-operation)');
    console.log('   - Guaranteed atomicity (all or nothing)');
    console.log('');
    console.log('   ⚠️  Constraints:');
    console.log('   - All operations must complete in single transaction');
    console.log('   - Transaction size limits (operations, compute, memory)');
    console.log('   - Gas/fee limits');
    console.log('   - If ANY step fails, ENTIRE transaction reverts');
    console.log('');
    console.log('   💡 Best Practices:');
    console.log('   - Keep operations simple and focused');
    console.log('   - Test gas usage thoroughly');
    console.log('   - Have fallback logic for edge cases');
    console.log('   - Simulate before executing on mainnet');
    console.log('');

    // ==========================================================================
    // TRANSACTION BUILDING PATTERNS
    // ==========================================================================
    
    console.log('🔧 Transaction Building Patterns');
    console.log('='.repeat(70));
    console.log('');
    console.log('   The SDK provides two levels of API:');
    console.log('');
    console.log('   1. High-Level: FlashLoanModule.execute()');
    console.log('      - Simplest approach');
    console.log('      - Handles transaction building automatically');
    console.log('      - Includes fee estimation and validation');
    console.log('      - Best for most use cases');
    console.log('');
    console.log('   2. Low-Level: PairClient.buildFlashLoan()');
    console.log('      - More control over transaction');
    console.log('      - Can combine with other operations');
    console.log('      - Useful for complex multi-operation transactions');
    console.log('      - Requires manual transaction building');
    console.log('');
    console.log('   When to use each:');
    console.log('   - Use execute() for standalone flash loans');
    console.log('   - Use buildFlashLoan() when combining with other operations');
    console.log('   - Use buildFlashLoan() for custom transaction logic');
    console.log('');

    // ==========================================================================
    // BEST PRACTICES FOR COMPLEX INTEGRATIONS
    // ==========================================================================
    
    console.log('✨ Best Practices');
    console.log('='.repeat(70));
    console.log('');
    console.log('   1. Always Check Configuration First');
    console.log('      - Verify flash loans are enabled (not locked)');
    console.log('      - Check fee structure');
    console.log('      - Validate maximum borrowable amount');
    console.log('');
    console.log('   2. Estimate Fees Accurately');
    console.log('      - Use estimateFee() before execution');
    console.log('      - Account for fee floor on small amounts');
    console.log('      - Include fees in profit calculations');
    console.log('');
    console.log('   3. Implement Robust Error Handling');
    console.log('      - Handle FlashLoanError (config issues)');
    console.log('      - Handle TransactionError (execution failures)');
    console.log('      - Provide clear error messages');
    console.log('      - Log errors for debugging');
    console.log('');
    console.log('   4. Test Thoroughly');
    console.log('      - Test on testnet extensively');
    console.log('      - Test with various amounts (small, large, edge cases)');
    console.log('      - Test failure scenarios');
    console.log('      - Simulate before mainnet execution');
    console.log('');
    console.log('   5. Monitor and Optimize');
    console.log('      - Track gas usage');
    console.log('      - Monitor success/failure rates');
    console.log('      - Optimize for gas efficiency');
    console.log('      - Keep receiver contract simple');
    console.log('');
    console.log('   6. Security Considerations');
    console.log('      - Implement reentrancy guards');
    console.log('      - Validate all inputs');
    console.log('      - Use slippage protection');
    console.log('      - Audit receiver contracts');
    console.log('');

    console.log('='.repeat(70));
    console.log('');
    console.log('✅ Advanced patterns guide complete!');
    console.log('');
    console.log('   This example demonstrated advanced flash loan concepts.');
    console.log('   To execute an actual flash loan, use flash-loan-basic.ts');
    console.log('   with your configured environment variables.');

  } catch (error) {
    console.log('');
    console.error('❌ Error occurred');
    console.log('');

    if (error instanceof FlashLoanError) {
      console.error('Flash Loan Error:', error.message);
    } else if (error instanceof TransactionError) {
      console.error('Transaction Error:', error.message);
      if (error.txHash) {
        console.error('Transaction Hash:', error.txHash);
      }
    } else {
      console.error('Unexpected error:', error);
    }
    
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error in flash-loan-advanced example:', err);
  process.exit(1);
});
