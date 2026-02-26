#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _};
use soroban_sdk::{Env, Address};
use crate::errors::PairError;

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

    // Test each parameter one by one
    assert_eq!(client.try_initialize(&zero_address, &token_a, &token_b, &lp_token), Err(Ok(PairError::ZeroAddress)));
    assert_eq!(client.try_initialize(&factory, &zero_address, &token_b, &lp_token), Err(Ok(PairError::ZeroAddress)));
    assert_eq!(client.try_initialize(&factory, &token_a, &zero_address, &lp_token), Err(Ok(PairError::ZeroAddress)));
    assert_eq!(client.try_initialize(&factory, &token_a, &token_b, &zero_address), Err(Ok(PairError::ZeroAddress)));
}
