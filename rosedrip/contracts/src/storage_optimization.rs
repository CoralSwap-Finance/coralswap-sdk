use soroban_sdk::{contracttype, Address, Env, BytesN};

#[contracttype]
pub struct PackedTimestamps {
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
pub struct OptimizedUserProfile {
    pub account: Address,
    pub timestamps: PackedTimestamps,
    pub flags: u32,
    pub bio_hash: BytesN<32>,
}
