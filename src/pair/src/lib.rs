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

    pub fn get_dynamic_fee(env: Env) -> u32 {
        let fee_state: FeeState = env.storage().instance().get(&DataKey::FeeState).unwrap();
        fee_state.baseline_bps
    }

    pub fn mint_with_one_token(
        env: Env,
        sender: Address,
        token: Address,
        amount: i128,
        min_lp_out: i128,
    ) -> Result<i128, PairError> {
        sender.require_auth();

        if amount <= 0 {
            return Err(PairError::InvalidAmount);
        }

        let mut storage: PairStorage = env.storage().instance().get(&DataKey::PairStorage).unwrap();
        let fee_state: FeeState = env.storage().instance().get(&DataKey::FeeState).unwrap();

        let is_token_0 = if token == storage.token_0 {
            true
        } else if token == storage.token_1 {
            false
        } else {
            return Err(PairError::ZeroAddress);
        };

        let (reserve_in, reserve_out) = if is_token_0 {
            (storage.reserve_0, storage.reserve_1)
        } else {
            (storage.reserve_1, storage.reserve_0)
        };

        if reserve_in <= 0 || reserve_out <= 0 {
            return Err(PairError::InsufficientLiquidity);
        }

        let fee_bps = fee_state.baseline_bps;
        let f = (10000 - fee_bps) as i128;

        let b = reserve_in * (10000 + f);
        let d = reserve_in * reserve_in * (10000 + f) * (10000 + f) + 40000 * f * amount * reserve_in;
        let sqrt_d = sqrt(d);
        let swap_amount = (sqrt_d - b) / (2 * f);

        if swap_amount >= amount {
            return Err(PairError::InvalidAmount);
        }

        let amount_out = (swap_amount * f * reserve_out) / (reserve_in * 10000 + swap_amount * f);
        if amount_out <= 0 {
            return Err(PairError::InsufficientOutputAmount);
        }

        let amount_in_deposited = amount - swap_amount;

        let lp_client = LPTokenClient::new(&env, &storage.lp_token);
        let lp_total_supply = lp_client.total_supply();

        let new_reserve_in = reserve_in + swap_amount;
        let new_reserve_out = reserve_out - amount_out;

        let lp_minted_in = (amount_in_deposited * lp_total_supply) / new_reserve_in;
        let lp_minted_out = (amount_out * lp_total_supply) / new_reserve_out;
        let lp_minted = lp_minted_in.min(lp_minted_out);

        if lp_minted < min_lp_out {
            return Err(PairError::InsufficientLiquidityMinted);
        }

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        lp_client.mint(&sender, &lp_minted);

        if is_token_0 {
            storage.reserve_0 = reserve_in + amount;
            storage.reserve_1 = reserve_out;
        } else {
            storage.reserve_0 = reserve_out;
            storage.reserve_1 = reserve_in + amount;
        }
        storage.block_timestamp_last = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::PairStorage, &storage);

        Ok(lp_minted)
    }
}

#[soroban_sdk::contractclient(name = "LPTokenClient")]
pub trait LPTokenTrait {
    fn total_supply(env: Env) -> i128;
    fn mint(env: Env, to: Address, amount: i128);
    fn burn(env: Env, from: Address, amount: i128);
}

fn sqrt(y: i128) -> i128 {
    if y < 0 {
        panic!("sqrt of negative number");
    }
    if y == 0 {
        return 0;
    }
    let mut z = y;
    let mut x = y / 2 + 1;
    while x < z {
        z = x;
        x = (y / x + x) / 2;
    }
    z
}

