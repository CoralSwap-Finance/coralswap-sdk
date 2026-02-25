#![no_std]

mod errors;
mod storage;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Address, Env, String};
use crate::errors::PairError;
use crate::storage::{DataKey, PairStorage, FeeState, ReentrancyGuard};

fn is_zero_address(env: &Env, address: &Address) -> bool {
    // We use a zeroed-out contract ID as the "zero address".
    // Since from_contract_id is private/unstable in some contexts, 
    // we use a valid but "empty" address representation.
    let zero_address = Address::from_string(&String::from_str(env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"));
    address == &zero_address
}

#[contract]
pub struct Pair;

#[contractimpl]
impl Pair {
    pub fn initialize(
        env: Env,
        factory: Address,
        token_a: Address,
        token_b: Address,
        lp_token: Address,
    ) -> Result<(), PairError> {
        // Double-init guard
        if env.storage().instance().has(&DataKey::PairStorage) {
            return Err(PairError::AlreadyInitialized);
        }

        // Zero-address validation
        if is_zero_address(&env, &factory) || 
           is_zero_address(&env, &token_a) || 
           is_zero_address(&env, &token_b) || 
           is_zero_address(&env, &lp_token) {
            return Err(PairError::ZeroAddress);
        }

        // Identical token check
        if token_a == token_b {
            return Err(PairError::IdenticalTokens);
        }

        // Persist PairStorage
        // Sort tokens to ensure deterministic order (though prompt didn't explicitly ask for sorting,
        // it's standard for Uniswap-like pairs). 
        // I'll stick to the provided parameters if they are already assumed sorted, 
        // but usually we sort token_a and token_b into token_0 and token_1.
        let (token_0, token_1) = if token_a < token_b {
            (token_a, token_b)
        } else {
            (token_b, token_a)
        };

        let storage = PairStorage {
            factory,
            token_0,
            token_1,
            lp_token,
            reserve_0: 0,
            reserve_1: 0,
            block_timestamp_last: 0,
        };
        env.storage().instance().set(&DataKey::PairStorage, &storage);

        // Initialize FeeState
        let fee_state = FeeState {
            baseline_bps: 30, // 30 bps
            min_bps: 10,
            max_bps: 100,
        };
        env.storage().instance().set(&DataKey::FeeState, &fee_state);

        // Initialize ReentrancyGuard
        let reentrancy_guard = ReentrancyGuard { locked: false };
        env.storage().instance().set(&DataKey::ReentrancyGuard, &reentrancy_guard);

        // Set storage TTL (7-day bump)
        // 7 days * 24 hours * 60 minutes * 12 ledgers/min (approx) = 120,960 ledgers
        // Or using common ledger counts: 1 day is ~17280 ledgers. 
        // 7 days ~ 120,960.
        env.storage().instance().extend_ttl(120_960, 120_960);

        Ok(())
    }

    pub fn get_reserves(env: Env) -> (i128, i128, u64) {
        let storage: PairStorage = env.storage().instance().get(&DataKey::PairStorage).unwrap();
        (storage.reserve_0, storage.reserve_1, storage.block_timestamp_last)
    }

    pub fn get_fee_state(env: Env) -> FeeState {
        env.storage().instance().get(&DataKey::FeeState).unwrap()
    }
}
