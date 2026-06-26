#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Env, Address, contract, contractimpl};
use crate::errors::PairError;

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_balance: i128 = env.storage().persistent().get(&from).unwrap_or(0);
        if from_balance < amount {
            panic!("insufficient balance");
        }
        let to_balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&from, &(from_balance - amount));
        env.storage().persistent().set(&to, &(to_balance + amount));
    }

    pub fn mint_mock(env: Env, to: Address, amount: i128) {
        let to_balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&to, &(to_balance + amount));
    }
    
    pub fn balance(env: Env, owner: Address) -> i128 {
        env.storage().persistent().get(&owner).unwrap_or(0)
    }
}

#[contract]
pub struct MockLPToken;

#[contractimpl]
impl MockLPToken {
    pub fn total_supply(env: Env) -> i128 {
        env.storage().persistent().get(&soroban_sdk::symbol_short!("supply")).unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let supply: i128 = env.storage().persistent().get(&soroban_sdk::symbol_short!("supply")).unwrap_or(0);
        env.storage().persistent().set(&soroban_sdk::symbol_short!("supply"), &(supply + amount));
        let balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&to, &(balance + amount));
    }

    pub fn set_supply(env: Env, amount: i128) {
        env.storage().persistent().set(&soroban_sdk::symbol_short!("supply"), &amount);
    }
}

#[test]
fn test_initialize_happy_path() {
    let env = Env::default();
    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let lp_token = Address::generate(&env);

    client.initialize(&factory, &token_a, &token_b, &lp_token);

    let (reserve_0, reserve_1, timestamp) = client.get_reserves();
    assert_eq!(reserve_0, 0);
    assert_eq!(reserve_1, 0);
    assert_eq!(timestamp, 0);

    let fee_state = client.get_fee_state();
    assert_eq!(fee_state.baseline_bps, 30);
    assert_eq!(fee_state.min_bps, 10);
    assert_eq!(fee_state.max_bps, 100);
}

#[test]
fn test_already_initialized() {
    let env = Env::default();
    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let lp_token = Address::generate(&env);

    client.initialize(&factory, &token_a, &token_b, &lp_token);

    let result = client.try_initialize(&factory, &token_a, &token_b, &lp_token);
    assert_eq!(result, Err(Ok(PairError::AlreadyInitialized)));
}

#[test]
fn test_identical_tokens() {
    let env = Env::default();
    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_a = Address::generate(&env);
    let lp_token = Address::generate(&env);

    let result = client.try_initialize(&factory, &token_a, &token_a, &lp_token);
    assert_eq!(result, Err(Ok(PairError::IdenticalTokens)));
}

#[test]
fn test_zero_address_validation() {
    let env = Env::default();
    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let lp_token = Address::generate(&env);
    
    let zero_address = Address::from_string(&soroban_sdk::String::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"));

    assert_eq!(client.try_initialize(&zero_address, &token_a, &token_b, &lp_token), Err(Ok(PairError::ZeroAddress)));
    assert_eq!(client.try_initialize(&factory, &zero_address, &token_b, &lp_token), Err(Ok(PairError::ZeroAddress)));
    assert_eq!(client.try_initialize(&factory, &token_a, &zero_address, &lp_token), Err(Ok(PairError::ZeroAddress)));
    assert_eq!(client.try_initialize(&factory, &token_a, &token_b, &zero_address), Err(Ok(PairError::ZeroAddress)));
}

#[test]
fn test_mint_with_one_token_token_0() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_0_id = env.register(MockToken, ());
    let token_1_id = env.register(MockToken, ());
    let lp_token_id = env.register(MockLPToken, ());

    let (t0, t1) = if token_0_id < token_1_id {
        (token_0_id.clone(), token_1_id.clone())
    } else {
        (token_1_id.clone(), token_0_id.clone())
    };

    client.initialize(&factory, &t0, &t1, &lp_token_id);

    // Setup initial reserves & supply
    env.as_contract(&contract_id, || {
        let mut storage = env.storage().instance().get::<_, PairStorage>(&DataKey::PairStorage).unwrap();
        storage.reserve_0 = 1000;
        storage.reserve_1 = 2000;
        env.storage().instance().set(&DataKey::PairStorage, &storage);
    });

    let lp_token_client = MockLPTokenClient::new(&env, &lp_token_id);
    lp_token_client.set_supply(&1414);

    let sender = Address::generate(&env);
    let token_0_client = MockTokenClient::new(&env, &t0);
    token_0_client.mint_mock(&sender, &500);

    let lp_out = client.mint_with_one_token(&sender, &t0, &500, &310);
    assert!(lp_out >= 310);

    let (r0, r1, _) = client.get_reserves();
    assert_eq!(r0, 1500);
    assert_eq!(r1, 2000);

    // Verify K invariant holds
    let k_start = 1000 * 2000;
    let k_end = r0 * r1;
    assert!(k_end > k_start);
}

#[test]
fn test_mint_with_one_token_token_1() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_0_id = env.register(MockToken, ());
    let token_1_id = env.register(MockToken, ());
    let lp_token_id = env.register(MockLPToken, ());

    let (t0, t1) = if token_0_id < token_1_id {
        (token_0_id.clone(), token_1_id.clone())
    } else {
        (token_1_id.clone(), token_0_id.clone())
    };

    client.initialize(&factory, &t0, &t1, &lp_token_id);

    // Setup initial reserves & supply
    env.as_contract(&contract_id, || {
        let mut storage = env.storage().instance().get::<_, PairStorage>(&DataKey::PairStorage).unwrap();
        storage.reserve_0 = 2000;
        storage.reserve_1 = 1000;
        env.storage().instance().set(&DataKey::PairStorage, &storage);
    });

    let lp_token_client = MockLPTokenClient::new(&env, &lp_token_id);
    lp_token_client.set_supply(&1414);

    let sender = Address::generate(&env);
    let token_1_client = MockTokenClient::new(&env, &t1);
    token_1_client.mint_mock(&sender, &500);

    let lp_out = client.mint_with_one_token(&sender, &t1, &500, &310);
    assert!(lp_out >= 310);

    let (r0, r1, _) = client.get_reserves();
    assert_eq!(r0, 2000);
    assert_eq!(r1, 1500);

    // Verify K invariant holds
    let k_start = 2000 * 1000;
    let k_end = r0 * r1;
    assert!(k_end > k_start);
}

#[test]
fn test_mint_with_one_token_slippage() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_0_id = env.register(MockToken, ());
    let token_1_id = env.register(MockToken, ());
    let lp_token_id = env.register(MockLPToken, ());

    let (t0, t1) = if token_0_id < token_1_id {
        (token_0_id.clone(), token_1_id.clone())
    } else {
        (token_1_id.clone(), token_0_id.clone())
    };

    client.initialize(&factory, &t0, &t1, &lp_token_id);

    // Setup initial reserves & supply
    env.as_contract(&contract_id, || {
        let mut storage = env.storage().instance().get::<_, PairStorage>(&DataKey::PairStorage).unwrap();
        storage.reserve_0 = 1000;
        storage.reserve_1 = 2000;
        env.storage().instance().set(&DataKey::PairStorage, &storage);
    });

    let lp_token_client = MockLPTokenClient::new(&env, &lp_token_id);
    lp_token_client.set_supply(&1414);

    let sender = Address::generate(&env);
    let token_0_client = MockTokenClient::new(&env, &t0);
    token_0_client.mint_mock(&sender, &500);

    // Requesting 500 LP tokens when maximum possible is ~316 should trigger slippage error
    let result = client.try_mint_with_one_token(&sender, &t0, &500, &500);
    assert_eq!(result, Err(Ok(PairError::InsufficientLiquidityMinted)));
}

#[test]
fn test_mint_with_one_token_insufficient_liquidity() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(Pair, ());
    let client = PairClient::new(&env, &contract_id);

    let factory = Address::generate(&env);
    let token_0_id = env.register(MockToken, ());
    let token_1_id = env.register(MockToken, ());
    let lp_token_id = env.register(MockLPToken, ());

    let (t0, t1) = if token_0_id < token_1_id {
        (token_0_id.clone(), token_1_id.clone())
    } else {
        (token_1_id.clone(), token_0_id.clone())
    };

    client.initialize(&factory, &t0, &t1, &lp_token_id);

    let sender = Address::generate(&env);
    let token_0_client = MockTokenClient::new(&env, &t0);
    token_0_client.mint_mock(&sender, &500);

    // Pool has reserves = 0, should reject with InsufficientLiquidity
    let result = client.try_mint_with_one_token(&sender, &t0, &500, &0);
    assert_eq!(result, Err(Ok(PairError::InsufficientLiquidity)));
}
