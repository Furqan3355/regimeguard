//! RegimeGuard: enforces an AI agent's spending limit on-chain, scaled by the market regime.
//!
//! Instructions (the first byte is the tag):
//!   0 InitOracle   [authority(s,w), oracle(w), system]        data: lamports u64
//!   1 UpdateOracle [authority(s), oracle(w), clock]           data: regime u8
//!   2 InitPolicy   [owner(s,w), policy(w), system]            data: lamports u64 + 6 addresses + base u64 + max_staleness u64
//!   3 SetPaused    [owner(s), policy(w)]                      data: paused u8
//!   4 Pull         [agent(s), policy(w), oracle, clock, subscriptions_program,
//!                   delegation(w), subscription_authority, delegator_ata(w), receiver_ata(w),
//!                   mint, token_program, guard_pda, event_authority]   data: amount u64

pub mod logic;
pub mod state;

use solana_account_info::AccountInfo;
use solana_address::{address, Address};
use solana_cpi::invoke_signed;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_entrypoint::{entrypoint, ProgramResult};
use solana_program_error::ProgramError;

use state::{oracle as o, policy as p, read_address, read_i64, read_u64, write_i64, write_u64};

entrypoint!(process_instruction);

pub const SUBSCRIPTIONS_ID: Address = address!("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");
pub const CLOCK_ID: Address = address!("SysvarC1ock11111111111111111111111111111111");
const SECONDS_PER_DAY: i64 = 86_400;

#[repr(u32)]
#[derive(Clone, Copy)]
pub enum GuardError {
    NotAgent = 1,
    Paused = 2,
    OracleMismatch = 3,
    BadAccount = 4,
    LimitExceeded = 5,
    BadData = 6,
    BadAuthority = 7,
    BadRegime = 8,
    WrongOwner = 9,
}

fn err(e: GuardError) -> ProgramError {
    ProgramError::Custom(e as u32)
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => init_oracle(program_id, accounts, data),
        Some(1) => update_oracle(program_id, accounts, data),
        Some(2) => init_policy(program_id, accounts, data),
        Some(3) => set_paused(program_id, accounts, data),
        Some(4) => pull(program_id, accounts, data),
        _ => Err(err(GuardError::BadData)),
    }
}

// ---------- helpers ----------

fn read_now(clock: &AccountInfo) -> Result<i64, ProgramError> {
    if *clock.key != CLOCK_ID {
        return Err(err(GuardError::BadAccount));
    }
    let d = clock.try_borrow_data()?;
    if d.len() < 40 {
        return Err(err(GuardError::BadAccount));
    }
    // Clock layout: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64
    Ok(i64::from_le_bytes(d[32..40].try_into().unwrap()))
}

fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    new_acc: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    lamports: u64,
    space: u64,
    owner: &Address,
    seeds: &[&[u8]],
) -> ProgramResult {
    if *system.key != Address::default() {
        return Err(err(GuardError::BadAccount));
    }
    // System program CreateAccount: u32 index 0 + lamports u64 + space u64 + owner [32]
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    let ix = Instruction {
        program_id: Address::default(),
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*new_acc.key, true),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[payer.clone(), new_acc.clone(), system.clone()],
        &[seeds],
    )
}

fn check_owner(acc: &AccountInfo, program_id: &Address) -> ProgramResult {
    if acc.owner != program_id {
        return Err(err(GuardError::WrongOwner));
    }
    Ok(())
}

// ---------- 0: InitOracle ----------

fn init_oracle(program_id: &Address, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 9 {
        return Err(err(GuardError::BadData));
    }
    let lamports = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let [authority, oracle, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !authority.is_signer {
        return Err(err(GuardError::BadAuthority));
    }
    let (pda, bump) =
        Address::find_program_address(&[b"oracle", authority.key.as_ref()], program_id);
    if *oracle.key != pda {
        return Err(err(GuardError::BadAccount));
    }
    let bump_arr = [bump];
    let seeds: [&[u8]; 3] = [&b"oracle"[..], authority.key.as_ref(), &bump_arr[..]];
    create_pda(authority, oracle, system, lamports, o::LEN as u64, program_id, &seeds)?;

    let mut d = oracle.try_borrow_mut_data()?;
    d[o::DISC] = state::ORACLE_DISC;
    d[o::AUTHORITY..o::AUTHORITY + 32].copy_from_slice(authority.key.as_ref());
    d[o::REGIME] = logic::CRISIS; // start with the strictest regime
    write_i64(&mut d[..], o::UPDATED_AT, 0);
    d[o::BUMP] = bump;
    Ok(())
}

// ---------- 1: UpdateOracle ----------

fn update_oracle(program_id: &Address, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 2 {
        return Err(err(GuardError::BadData));
    }
    let regime = data[1];
    if regime > logic::CRISIS {
        return Err(err(GuardError::BadRegime));
    }
    let [authority, oracle, clock] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !authority.is_signer {
        return Err(err(GuardError::BadAuthority));
    }
    check_owner(oracle, program_id)?;
    let now = read_now(clock)?;

    let mut d = oracle.try_borrow_mut_data()?;
    if d.len() != o::LEN || d[o::DISC] != state::ORACLE_DISC {
        return Err(err(GuardError::BadAccount));
    }
    if read_address(&d[..], o::AUTHORITY) != *authority.key {
        return Err(err(GuardError::BadAuthority));
    }
    d[o::REGIME] = regime;
    write_i64(&mut d[..], o::UPDATED_AT, now);
    Ok(())
}

// ---------- 2: InitPolicy ----------

fn init_policy(program_id: &Address, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // tag(1) + lamports(8) + agent,oracle,mint,delegator_ata,receiver_ata,delegation (6*32) + base(8) + max_staleness(8)
    if data.len() != 217 {
        return Err(err(GuardError::BadData));
    }
    let lamports = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let agent = read_address(data, 9);
    let [owner, policy, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer {
        return Err(err(GuardError::BadAuthority));
    }
    let (pda, bump) = Address::find_program_address(&[b"policy", agent.as_ref()], program_id);
    if *policy.key != pda {
        return Err(err(GuardError::BadAccount));
    }
    let bump_arr = [bump];
    let seeds: [&[u8]; 3] = [&b"policy"[..], agent.as_ref(), &bump_arr[..]];
    create_pda(owner, policy, system, lamports, p::LEN as u64, program_id, &seeds)?;

    let mut d = policy.try_borrow_mut_data()?;
    d[p::DISC] = state::POLICY_DISC;
    d[p::OWNER..p::OWNER + 32].copy_from_slice(owner.key.as_ref());
    d[p::AGENT..p::AGENT + 32].copy_from_slice(&data[9..41]);
    d[p::ORACLE..p::ORACLE + 32].copy_from_slice(&data[41..73]);
    d[p::MINT..p::MINT + 32].copy_from_slice(&data[73..105]);
    d[p::DELEGATOR_ATA..p::DELEGATOR_ATA + 32].copy_from_slice(&data[105..137]);
    d[p::RECEIVER_ATA..p::RECEIVER_ATA + 32].copy_from_slice(&data[137..169]);
    d[p::DELEGATION..p::DELEGATION + 32].copy_from_slice(&data[169..201]);
    write_u64(&mut d[..], p::BASE_LIMIT, read_u64(data, 201));
    write_u64(&mut d[..], p::MAX_STALENESS, read_u64(data, 209));
    write_i64(&mut d[..], p::DAY, 0);
    write_u64(&mut d[..], p::SPENT, 0);
    d[p::PAUSED] = 0;
    d[p::BUMP] = bump;
    Ok(())
}

// ---------- 3: SetPaused ----------

fn set_paused(program_id: &Address, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 2 || data[1] > 1 {
        return Err(err(GuardError::BadData));
    }
    let [owner, policy] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer {
        return Err(err(GuardError::BadAuthority));
    }
    check_owner(policy, program_id)?;
    let mut d = policy.try_borrow_mut_data()?;
    if d.len() != p::LEN || d[p::DISC] != state::POLICY_DISC {
        return Err(err(GuardError::BadAccount));
    }
    if read_address(&d[..], p::OWNER) != *owner.key {
        return Err(err(GuardError::BadAuthority));
    }
    d[p::PAUSED] = data[1];
    Ok(())
}

// ---------- 4: Pull ----------

fn pull(program_id: &Address, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 9 || accounts.len() < 13 {
        return Err(err(GuardError::BadData));
    }
    let amount = u64::from_le_bytes(data[1..9].try_into().unwrap());

    let agent = &accounts[0];
    let policy = &accounts[1];
    let oracle = &accounts[2];
    let clock = &accounts[3];
    let subs = &accounts[4];
    let delegation = &accounts[5];
    let sub_authority = &accounts[6];
    let delegator_ata = &accounts[7];
    let receiver_ata = &accounts[8];
    let mint = &accounts[9];
    let token_program = &accounts[10];
    let guard_acc = &accounts[11];
    let event_authority = &accounts[12];

    if !agent.is_signer {
        return Err(err(GuardError::NotAgent));
    }
    check_owner(policy, program_id)?;
    check_owner(oracle, program_id)?;
    if *subs.key != SUBSCRIPTIONS_ID {
        return Err(err(GuardError::BadAccount));
    }
    let now = read_now(clock)?;

    // --- read the policy (keep the borrow short) ---
    let (owner_key, base_limit, max_staleness, day_stored, spent);
    {
        let d = policy.try_borrow_data()?;
        if d.len() != p::LEN || d[p::DISC] != state::POLICY_DISC {
            return Err(err(GuardError::BadAccount));
        }
        if read_address(&d[..], p::AGENT) != *agent.key {
            return Err(err(GuardError::NotAgent));
        }
        if d[p::PAUSED] != 0 {
            return Err(err(GuardError::Paused));
        }
        if read_address(&d[..], p::ORACLE) != *oracle.key {
            return Err(err(GuardError::OracleMismatch));
        }
        // The agent cannot swap these accounts: all of them are bound to the policy
        if read_address(&d[..], p::DELEGATION) != *delegation.key
            || read_address(&d[..], p::DELEGATOR_ATA) != *delegator_ata.key
            || read_address(&d[..], p::RECEIVER_ATA) != *receiver_ata.key
            || read_address(&d[..], p::MINT) != *mint.key
        {
            return Err(err(GuardError::BadAccount));
        }
        owner_key = read_address(&d[..], p::OWNER);
        base_limit = read_u64(&d[..], p::BASE_LIMIT);
        max_staleness = read_u64(&d[..], p::MAX_STALENESS);
        day_stored = read_i64(&d[..], p::DAY);
        spent = read_u64(&d[..], p::SPENT);
    }

    // --- read the oracle ---
    let (regime, updated_at);
    {
        let d = oracle.try_borrow_data()?;
        if d.len() != o::LEN || d[o::DISC] != state::ORACLE_DISC {
            return Err(err(GuardError::BadAccount));
        }
        regime = d[o::REGIME];
        updated_at = read_i64(&d[..], o::UPDATED_AT);
    }

    // --- limit check ---
    let eff = logic::effective_regime(regime, updated_at, now, max_staleness);
    let limit = logic::effective_limit(base_limit, eff);
    let now_day = now.div_euclid(SECONDS_PER_DAY);
    let new_spent = logic::spend_after(day_stored, spent, now_day, limit, amount)
        .ok_or(err(GuardError::LimitExceeded))?;

    // Write the state first, then move the funds (if the CPI fails the whole transaction reverts)
    {
        let mut d = policy.try_borrow_mut_data()?;
        write_i64(&mut d[..], p::DAY, now_day);
        write_u64(&mut d[..], p::SPENT, new_spent);
    }

    // --- CPI into the Subscriptions program (the guard PDA signs as the delegatee) ---
    let (guard_pda, bump) = Address::find_program_address(&[b"guard"], program_id);
    if *guard_acc.key != guard_pda {
        return Err(err(GuardError::BadAccount));
    }

    // TransferFixed data: discriminator 4 + TransferData { amount u64, delegator [32], mint [32] }
    let mut ix_data = Vec::with_capacity(73);
    ix_data.push(4u8);
    ix_data.extend_from_slice(&amount.to_le_bytes());
    ix_data.extend_from_slice(owner_key.as_ref());
    ix_data.extend_from_slice(mint.key.as_ref());

    let metas = vec![
        AccountMeta::new(*delegation.key, false),
        AccountMeta::new_readonly(*sub_authority.key, false),
        AccountMeta::new(*delegator_ata.key, false),
        AccountMeta::new(*receiver_ata.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(guard_pda, true),
        AccountMeta::new_readonly(*event_authority.key, false),
        AccountMeta::new_readonly(SUBSCRIPTIONS_ID, false),
    ];
    let ix = Instruction {
        program_id: SUBSCRIPTIONS_ID,
        accounts: metas,
        data: ix_data,
    };
    invoke_signed(&ix, accounts, &[&[b"guard", &[bump]]])
}
