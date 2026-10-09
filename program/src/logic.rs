//! Pure logic: no accounts and no chain, which is why it is easy to unit test.
//! (Same multipliers as the TypeScript regime engine.)

pub const CALM: u8 = 0;
pub const TREND: u8 = 1;
pub const VOLATILE: u8 = 2;
pub const CRISIS: u8 = 3;

/// basis points: 10_000 = 100%
pub const MULT_BPS: [u64; 4] = [10_000, 8_000, 3_000, 0];

/// If the oracle is stale or invalid, use the strictest regime (CRISIS).
pub fn effective_regime(regime: u8, updated_at: i64, now: i64, max_staleness: u64) -> u8 {
    if regime > CRISIS || updated_at <= 0 || now < updated_at {
        return CRISIS;
    }
    if ((now - updated_at) as u64) > max_staleness {
        CRISIS
    } else {
        regime
    }
}

/// Today's limit = base * multiplier / 10_000
pub fn effective_limit(base: u64, regime: u8) -> u64 {
    let m = MULT_BPS[regime.min(CRISIS) as usize] as u128;
    (((base as u128) * m) / 10_000u128) as u64
}

/// Returns the new "spent today", or None if the limit is exceeded or the amount overflows.
pub fn spend_after(day_stored: i64, spent: u64, now_day: i64, limit: u64, amount: u64) -> Option<u64> {
    let base = if day_stored == now_day { spent } else { 0 };
    let new_spent = base.checked_add(amount)?;
    if new_spent > limit {
        None
    } else {
        Some(new_spent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_follow_regime() {
        assert_eq!(effective_limit(100, CALM), 100);
        assert_eq!(effective_limit(100, TREND), 80);
        assert_eq!(effective_limit(100, VOLATILE), 30);
        assert_eq!(effective_limit(100, CRISIS), 0);
    }

    #[test]
    fn limit_math_does_not_overflow() {
        assert_eq!(effective_limit(u64::MAX, CALM), u64::MAX);
    }

    #[test]
    fn fresh_oracle_keeps_regime() {
        assert_eq!(effective_regime(VOLATILE, 1_000, 1_100, 300), VOLATILE);
    }

    #[test]
    fn stale_oracle_is_crisis() {
        assert_eq!(effective_regime(CALM, 1_000, 1_400, 300), CRISIS);
    }

    #[test]
    fn never_updated_oracle_is_crisis() {
        assert_eq!(effective_regime(CALM, 0, 1_000, 300), CRISIS);
    }

    #[test]
    fn invalid_regime_is_crisis() {
        assert_eq!(effective_regime(9, 1_000, 1_010, 300), CRISIS);
    }

    #[test]
    fn spend_within_limit() {
        assert_eq!(spend_after(5, 10, 5, 50, 20), Some(30));
    }

    #[test]
    fn spend_over_limit_is_rejected() {
        assert_eq!(spend_after(5, 40, 5, 50, 20), None);
    }

    #[test]
    fn exactly_at_limit_is_allowed() {
        assert_eq!(spend_after(5, 30, 5, 50, 20), Some(50));
    }

    #[test]
    fn new_day_resets_spent() {
        assert_eq!(spend_after(5, 50, 6, 50, 20), Some(20));
    }

    #[test]
    fn crisis_blocks_everything() {
        let limit = effective_limit(100, CRISIS);
        assert_eq!(spend_after(5, 0, 5, limit, 1), None);
    }

    #[test]
    fn overflow_is_rejected() {
        assert_eq!(spend_after(5, u64::MAX, 5, u64::MAX, 1), None);
    }
}
