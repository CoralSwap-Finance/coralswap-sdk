/**
 * Basic Flash Loan Example
 * 
 * This example demonstrates how to execute a flash loan using the CoralSwap SDK.
 * Flash loans allow you to borrow tokens without collateral, as long as you return
 * the borrowed amount plus a fee within the same transaction.
 * 
 * Prerequisites:
 * - A deployed flash receiver contract that implements the on_flash_loan callback
 * - Sufficient tokens in the pair reserves
 * - Environment variables configured (see .env.example)
 * 
 * This example covers:
 * - Checking flash loan availability
 * - Estimating flash loan fees
 * - Calculating total repayment amount
 * - Executing a flash loan transaction
 * - Handling common errors
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
  // Load and validate all required environment variables
  
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const pairAddress = process.env.CORALSWAP_PAIR_ADDRESS;
  const flashToken = process.env.CORALSWAP_FLASH_TOKEN;
  const flashAmountStr = process.env.CORALSWAP_FLASH_AMOUNT;
  const flashReceiver = process.env.CORALSWAP_FLASH_RECEIVER;

  // Validate that all required environment variables are present
  if (!rpcUrl || !secretKey || !publicKey || !pairAddress || !flashToken || !flashAmountStr || !flashReceiver) {
    console.error('❌ Missing required environment variables.');
    console.error('Please ensure the following are set in your .env file:');
    console.error('  - CORALSWAP_RPC_URL');
    console.error('  - CORALSWAP_SECRET_KEY');
    console.error('  - CORALSWAP_PUBLIC_KEY');
    console.error('  - CORALSWAP_PAIR_ADDRESS');
    console.error('  - CORALSWAP_FLASH_TOKEN');
    console.error('  - CORALSWAP_FLASH_AMOUNT');
    console.error('  - CORALSWAP_FLASH_RECEIVER');
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;
  const flashAmount = BigInt(flashAmountStr);

  console.log('🔧 Configuration:');
  console.log(`  Network: ${networkEnv}`);
  console.log(`  Pair Address: ${pairAddress}`);
  console.log(`  Token: ${flashToken}`);
  console.log(`  Amount: ${flashAmount.toString()}`);
  console.log(`  Receiver: ${flashReceiver}`);
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
    // Step 1: Check Flash Loan Availability
    // ==========================================================================
    // Before attempting a flash loan, verify that flash loans are enabled
    // for this pair. Pairs can disable flash loans by setting locked: true.
    
    console.log('📋 Checking flash loan availability...');
    const available = await flashLoanModule.isAvailable(pairAddress);
    
    if (!available) {
      console.error('❌ Flash loans are not available for this pair.');
      console.error('The pair may have flash loans disabled (locked: true).');
      process.exit(1);
    }
    
    console.log('✅ Flash loans are available for this pair');
    console.log('');

    // ==========================================================================
    // Step 2: Estimate Flash Loan Fee
    // ==========================================================================
    // Flash loans charge a fee based on the borrowed amount. The fee is
    // calculated as a percentage (in basis points) of the borrowed amount,
    // with a minimum fee floor to prevent dust attacks.
    //
    // Fee Structure:
    // - Fee is calculated as: (amount * feeBps) / 10000
    // - If calculated fee < feeFloor, the feeFloor is used instead
    // - Example: 9 bps = 0.09% fee
    
    console.log('💰 Estimating flash loan fee...');
    const feeEstimate = await flashLoanModule.estimateFee(
      pairAddress,
      flashToken,
      flashAmount
    );
    
    console.log(`  Fee Rate: ${feeEstimate.feeBps} bps (${(feeEstimate.feeBps / 100).toFixed(2)}%)`);
    console.log(`  Fee Floor: ${feeEstimate.feeFloor} units`);
    console.log(`  Calculated Fee: ${feeEstimate.feeAmount.toString()} units`);
    console.log('');

    // ==========================================================================
    // Step 3: Calculate Total Repayment Amount
    // ==========================================================================
    // The flash receiver contract must return the borrowed amount PLUS the fee.
    // Use calculateRepayment() to determine the exact amount to repay.
    
    const totalRepayment = flashLoanModule.calculateRepayment(
      flashAmount,
      feeEstimate.feeBps
    );
    
    console.log('📊 Repayment calculation:');
    console.log(`  Borrowed Amount: ${flashAmount.toString()} units`);
    console.log(`  Fee: ${feeEstimate.feeAmount.toString()} units`);
    console.log(`  Total Repayment: ${totalRepayment.toString()} units`);
    console.log('');

    // ==========================================================================
    // Step 4: Prepare Callback Data
    // ==========================================================================
    // The callback data is passed to your flash receiver contract's
    // on_flash_loan callback. You can encode any data your receiver needs
    // to perform its operations (e.g., swap parameters, target addresses).
    
    const callbackData = encodeFlashLoanData({
      operation: 'example',
      timestamp: Date.now(),
      // Add any custom data your receiver contract needs
    });

    console.log('📦 Callback data prepared');
    console.log('');

    // ==========================================================================
    // Step 5: Execute Flash Loan
    // ==========================================================================
    // Execute the flash loan transaction. This will:
    // 1. Transfer the borrowed tokens to your receiver contract
    // 2. Call your receiver's on_flash_loan callback
    // 3. Verify that the borrowed amount + fee was returned
    // 4. Complete the transaction (or revert if repayment fails)
    //
    // All of this happens atomically in a single transaction.
    
    console.log('🚀 Executing flash loan...');
    const result = await flashLoanModule.execute({
      pairAddress,
      token: flashToken,
      amount: flashAmount,
      receiverAddress: flashReceiver,
      callbackData,
    });

    // ==========================================================================
    // Success! Display Results
    // ==========================================================================
    
    console.log('');
    console.log('✅ Flash loan executed successfully!');
    console.log('');
    console.log('📄 Transaction Details:');
    console.log(`  Transaction Hash: ${result.txHash}`);
    console.log(`  Token: ${result.token}`);
    console.log(`  Amount Borrowed: ${result.amount.toString()} units`);
    console.log(`  Fee Paid: ${result.fee.toString()} units`);
    console.log(`  Ledger: ${result.ledger}`);
    console.log('');
    console.log('💡 The borrowed tokens were sent to your receiver contract,');
    console.log('   which performed its operations and returned the tokens + fee.');
    console.log('   All of this happened atomically in a single transaction.');

  } catch (error) {
    // ==========================================================================
    // Error Handling
    // ==========================================================================
    // Handle different types of errors that can occur during flash loan execution
    
    console.log('');
    console.error('❌ Flash loan failed');
    console.log('');

    if (error instanceof FlashLoanError) {
      // FlashLoanError: Configuration or validation issues
      // Common causes:
      // - Flash loans are disabled (locked: true)
      // - Fee configuration is invalid
      // - Invalid addresses or amounts
      console.error('Flash Loan Error:', error.message);
      console.log('');
      console.log('💡 Common causes:');
      console.log('   - Flash loans may be disabled for this pair');
      console.log('   - Check that your pair address is correct');
      console.log('   - Verify the token address is valid');
      
    } else if (error instanceof TransactionError) {
      // TransactionError: Transaction execution failed
      // Common causes:
      // - Receiver callback returned false or reverted
      // - Insufficient repayment (didn\'t return principal + fee)
      // - Receiver contract doesn\'t implement on_flash_loan
      // - Insufficient reserves in the pair
      console.error('Transaction Error:', error.message);
      if (error.txHash) {
        console.error('Transaction Hash:', error.txHash);
      }
      console.log('');
      console.log('💡 Common causes:');
      console.log('   - Receiver callback failed or returned false');
      console.log('   - Insufficient repayment (must return principal + fee)');
      console.log('   - Receiver contract doesn\'t implement on_flash_loan');
      console.log('   - Insufficient reserves in the pair');
      
    } else {
      // Unexpected error
      console.error('Unexpected error:', error);
    }
    
    process.exit(1);
  }
}

// Execute the main function and handle any unhandled promise rejections
main().catch((err) => {
  console.error('Unhandled error in flash-loan-basic example:', err);
  process.exit(1);
});
