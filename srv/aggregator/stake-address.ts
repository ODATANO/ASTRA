/**
 * The wallet behind a Cardano address is its stake address: one wallet, many payment addresses,
 * all with the same stake credential. Enterprise, pointer and Byron addresses have none.
 */
import { bech32 } from 'bech32';

/** Base addresses are 1 header byte + 28 payment + 28 stake bytes; bech32 limits the length to 90 by default. */
const BASE_ADDRESS_BYTES = 57;
const BECH32_LIMIT = 120;

export interface StakeCredential {
  /** `stake1…` on mainnet, `stake_test1…` elsewhere. */
  stakeAddress: string;
  /** The stake part is a script, not a key: the funds answer to a validator, not to a wallet. */
  isScript: boolean;
}

/** Stake part of a base address, null for every other form or for a string that is not a bech32 address. */
export function stakeCredentialOf(address: string): StakeCredential | null {
  let bytes: number[];
  try {
    bytes = bech32.fromWords(bech32.decode(address, BECH32_LIMIT).words);
  } catch {
    return null;
  }
  if (bytes.length !== BASE_ADDRESS_BYTES) return null;
  const header = bytes[0];
  const type = header >> 4;
  if (type > 3) return null;                 // 0-3 = base address (payment x stake, key or script each)
  const isScript = (type & 2) !== 0;
  const network = header & 0x0f;
  const rewardHeader = ((isScript ? 0xf : 0xe) << 4) | network;
  const prefix = network === 1 ? 'stake' : 'stake_test';
  return { stakeAddress: bech32.encode(prefix, bech32.toWords([rewardHeader, ...bytes.slice(29)]), BECH32_LIMIT), isScript };
}

export function stakeAddressOf(address: string): string | null {
  return stakeCredentialOf(address)?.stakeAddress ?? null;
}
