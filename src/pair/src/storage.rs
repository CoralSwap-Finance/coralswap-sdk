use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    PairStorage,
    FeeState,
    ReentrancyGuard,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PairStorage {
    pub factory: Address,
    pub token_0: Address,
    pub token_1: Address,
    pub lp_token: Address,
    pub reserve_0: i128,
    pub reserve_1: i128,
    pub block_timestamp_last: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct FeeState {
    pub baseline_bps: u32,
    pub min_bps: u32,
    pub max_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ReentrancyGuard {
    pub locked: bool,
}
