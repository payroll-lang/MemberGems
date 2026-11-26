import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyHashRaw, parseLegacyHash, verifyLegacyPassword } from '../../src/lib/auth/legacyHash';

// Independent re-statement of Apps Script's behaviour, used as the oracle:
// base64EncodeWebSafe(computeHmacSha256Signature(value, key)) keeps '=' padding.
function oracle(password: string, salt: string, pepper: string, rounds: number) {
  let h = password;
  for (let i = 0; i < rounds; i++) {
    const b64 = createHmac('sha256', `${pepper}|${salt}`).update(h).digest('base64');
    h = b64.split('+').join('-').split('/').join('_');
  }
  return h;
}

describe('legacy Apps Script password hashes', () => {
  const pepper = 'Zx9kQw2-pepper_example_value_padded_44chars=';
  const salt = 'RbJe8bhIHXyrWGUJf-vqGTy6NKunWunQ';

  it('matches the oracle and keeps padding', () => {
    const h = legacyHashRaw('Secret123', salt, pepper, 200);
    expect(h).toBe(oracle('Secret123', salt, pepper, 200));
    expect(h.endsWith('=')).toBe(true);
    expect(h).toHaveLength(44);
  });

  it('verifies r200$ and unprefixed (5000-round) hashes', () => {
    expect(verifyLegacyPassword('Secret123', salt, 'r200$' + oracle('Secret123', salt, pepper, 200), pepper)).toBe(true);
    expect(verifyLegacyPassword('Secret123', salt, oracle('Secret123', salt, pepper, 5000), pepper)).toBe(true);
    expect(verifyLegacyPassword('Wrong1234', salt, 'r200$' + oracle('Secret123', salt, pepper, 200), pepper)).toBe(false);
    expect(verifyLegacyPassword('Secret123', salt, '', pepper)).toBe(false);
  });

  it('parses formats', () => {
    expect(parseLegacyHash('r200$abc=')).toEqual({ rounds: 200, digest: 'abc=' });
    expect(parseLegacyHash('abc=')).toEqual({ rounds: 5000, digest: 'abc=' });
  });
});
