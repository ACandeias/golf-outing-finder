/** Crockford base32, the ULID alphabet. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID from a timestamp and 10 bytes of randomness. Callers pass the bytes so
 * ids can be deterministic (a hash of a stable key) or random (crypto).
 */
export function ulid(timeMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new Error(`bad ULID time: ${timeMs}`);
  if (random.length < 10) throw new Error("ULID needs 10 random bytes");
  let time = "";
  let t = timeMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 bits of randomness as 16 base32 characters.
  let bits = 0;
  let value = 0;
  let rand = "";
  for (let i = 0; i < 10; i++) {
    value = (value << 8) | (random[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return time + rand;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
