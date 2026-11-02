import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based codes, RFC 6238, by hand — and the reason that is acceptable here.
 *
 * TOTP is thirty lines of HMAC and a modulo. There is nothing to get subtly wrong the way there is
 * in, say, WebAuthn: the algorithm is fully specified, the test vectors are published, and this
 * file is checked against them. Pulling a dependency for it would be a larger surface than the
 * thing it replaces.
 *
 * Two details that are easy to leave out and matter:
 *
 *  - **A window of one step either way.** Clocks drift and people finish typing after the code
 *    rolls over. Zero tolerance produces "the code is wrong" for a code that was right a second
 *    ago, which teaches people to distrust the feature rather than their clock.
 *  - **Constant-time comparison.** Comparing six digits with `===` leaks how many leading digits
 *    were right, one request at a time. Six digits is a small enough space that this is not
 *    theoretical.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;
/** One step back and one forward. Beyond that the clock, not the code, is the problem. */
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new shared secret, in the base32 an authenticator app expects. */
export function newTotpSecret(): string {
    return encodeBase32(randomBytes(20));
}

/**
 * What an authenticator app scans.
 *
 * The issuer appears twice on purpose — once as a path prefix and once as a parameter — because
 * that is what the apps actually read, and getting it wrong shows up as an entry called after the
 * account with no clue which tool it belongs to.
 */
export function totpUri(secret: string, account: string, issuer = 'Proton Mail Sorter'): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const query = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${query.toString()}`;
}

export function totpCode(secret: string, atSeconds: number = Math.floor(Date.now() / 1000)): string {
    const counter = Math.floor(atSeconds / STEP_SECONDS);
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));

    const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
    // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks the offset.
    const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
    const binary =
        (((digest[offset] ?? 0) & 0x7f) << 24) |
        (((digest[offset + 1] ?? 0) & 0xff) << 16) |
        (((digest[offset + 2] ?? 0) & 0xff) << 8) |
        ((digest[offset + 3] ?? 0) & 0xff);

    return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function verifyTotp(
    secret: string,
    code: string,
    atSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
    const cleaned = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(cleaned)) {
        return false;
    }

    let matched = false;
    for (let step = -WINDOW; step <= WINDOW; step++) {
        const expected = totpCode(secret, atSeconds + step * STEP_SECONDS);
        // Every candidate is compared, and the loop does not break early: an early return would
        // make a code that matches the first window measurably faster than one matching the last.
        if (constantTimeEqual(expected, cleaned)) {
            matched = true;
        }
    }
    return matched;
}

function constantTimeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}

function encodeBase32(bytes: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32[(value << (5 - bits)) & 31];
    }
    return output;
}

function decodeBase32(secret: string): Buffer {
    const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const character of cleaned) {
        value = (value << 5) | BASE32.indexOf(character);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}
