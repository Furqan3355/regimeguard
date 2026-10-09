//! Account layouts (hand-written byte offsets, no framework).

use solana_address::Address;

pub const POLICY_DISC: u8 = 1;
pub const ORACLE_DISC: u8 = 2;

/// Policy account: one policy per agent. PDA seeds: ["policy", agent]
pub mod policy {
    pub const DISC: usize = 0;
    pub const OWNER: usize = 1;
    pub const AGENT: usize = 33;
    pub const ORACLE: usize = 65;
    pub const MINT: usize = 97;
    pub const DELEGATOR_ATA: usize = 129;
    pub const RECEIVER_ATA: usize = 161;
    pub const DELEGATION: usize = 193;
    pub const BASE_LIMIT: usize = 225; // u64, base daily limit
    pub const MAX_STALENESS: usize = 233; // u64, seconds
    pub const DAY: usize = 241; // i64, day of the last spend (unix_ts / 86400)
    pub const SPENT: usize = 249; // u64, amount spent on that day
    pub const PAUSED: usize = 257; // u8
    pub const BUMP: usize = 258; // u8
    pub const LEN: usize = 259;
}

/// Oracle account: regime. PDA seeds: ["oracle", authority]
pub mod oracle {
    pub const DISC: usize = 0;
    pub const AUTHORITY: usize = 1;
    pub const REGIME: usize = 33; // u8: 0 CALM, 1 TREND, 2 VOLATILE, 3 CRISIS
    pub const UPDATED_AT: usize = 34; // i64
    pub const BUMP: usize = 42;
    pub const LEN: usize = 43;
}

pub fn read_address(d: &[u8], off: usize) -> Address {
    let mut a = [0u8; 32];
    a.copy_from_slice(&d[off..off + 32]);
    Address::from(a)
}

pub fn read_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}

pub fn read_i64(d: &[u8], off: usize) -> i64 {
    i64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}

pub fn write_u64(d: &mut [u8], off: usize, v: u64) {
    d[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

pub fn write_i64(d: &mut [u8], off: usize, v: i64) {
    d[off..off + 8].copy_from_slice(&v.to_le_bytes());
}
