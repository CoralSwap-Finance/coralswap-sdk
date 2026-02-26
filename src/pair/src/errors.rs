use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PairError {
    AlreadyInitialized = 100,
    ZeroAddress = 101,
    IdenticalTokens = 102,
    InsufficientLiquidityMinted = 103,
    InsufficientLiquidityBurned = 104,
    InsufficientOutputAmount = 105,
    InsufficientLiquidity = 106,
    InvalidAmount = 107,
    KInvariant = 108,
    InsufficientInputAmount = 109,
    Locked = 110,
    Expired = 111,
    ConstraintNotMet = 112,
    InvalidFee = 113,
}
