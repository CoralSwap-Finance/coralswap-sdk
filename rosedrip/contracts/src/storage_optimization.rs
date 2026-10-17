use soroban_sdk::{contracttype, Address, BytesN};

#[contracttype]
pub struct PackedTimestamps {
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
pub struct AetherMintUserProfile {
    pub account: Address,
    pub timestamps: PackedTimestamps,
    pub flags: u32,
    pub identity_hash: BytesN<32>,
}
