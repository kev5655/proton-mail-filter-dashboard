import { startAuthentication } from '@simplewebauthn/browser';

/**
 * A WebAuthn assertion that also produces key material.
 *
 * This exists because `@simplewebauthn/browser` does not know about the PRF extension — searched
 * for, and there is no mention of `prf` anywhere in version 13.3.0. What it *does* do is spread
 * `optionsJSON` straight into the object handed to `navigator.credentials.get()`, converting only
 * `challenge` and `allowCredentials`. So the extension travels through untouched, which means the
 * salt has to arrive already as bytes: the browser API wants a `BufferSource`, and a base64 string
 * left in place makes `get()` throw a `TypeError` with nothing in it about PRF.
 *
 * The output comes back the same way — `clientExtensionResults` is returned raw, so
 * `prf.results.first` is an `ArrayBuffer` rather than something that would survive `JSON.stringify`.
 * It is read out here and sent as its own field.
 *
 * **The PRF output is key material and is treated as such.** It is stripped from the response before
 * that is sent, so it cannot end up inside an object that gets logged or journalled; it travels in a
 * field of its own, to one action, over the same origin the password already uses.
 */

/**
 * The authenticator cannot produce key material, which is not a failure of anything.
 *
 * Its own type because the two callers answer it differently: releasing a passkey for unlocking
 * reports „dieser Authenticator kann das nicht, er bleibt zweiter Faktor" and carries on, while
 * unlocking with one has nothing left to try. A message string cannot be told apart from a real
 * refusal, and treating „kann kein PRF" as a rejected passkey is how somebody concludes their
 * hardware is broken.
 */
export class PrfUnsupportedError extends Error {
    constructor() {
        super(
            'Dieser Passkey liefert kein Schlüsselmaterial. Der Authenticator unterstützt die ' +
                'PRF-Erweiterung nicht — als zweiter Faktor funktioniert er weiterhin.'
        );
        this.name = 'PrfUnsupportedError';
    }
}

export interface PrfAssertion {
    /** The assertion, without its extension results. */
    response: unknown;
    /** The PRF output, standard base64 — the encoding `Buffer.from(x, 'base64')` expects. */
    prfOutput: string;
}

/**
 * Perform the assertion, or say why no key came out of it.
 *
 * A missing result is the ordinary case for an authenticator that cannot do PRF, and it must not be
 * reported as a failed login: nothing is wrong with the passkey, it simply cannot be the key.
 */
export async function assertWithPrf(optionsJSON: unknown): Promise<PrfAssertion> {
    const options = optionsJSON as {
        extensions?: { prf?: { eval?: { first?: unknown } } };
    };
    const salt = options.extensions?.prf?.eval?.first;
    if (typeof salt !== 'string') {
        throw new Error('Der Server hat kein PRF-Salt mitgeschickt. Es wurde nichts aufgeschlossen.');
    }

    const assertion = await startAuthentication({
        optionsJSON: {
            ...(optionsJSON as object),
            extensions: {
                ...options.extensions,
                prf: { eval: { first: fromBase64(salt) } },
            },
        } as never,
    });

    const first = (
        assertion.clientExtensionResults as {
            prf?: { results?: { first?: ArrayBuffer | Uint8Array } };
        }
    ).prf?.results?.first;

    if (first === undefined) {
        throw new PrfUnsupportedError();
    }

    // Deliberately dropped: extension results carry the very bytes that are the key here, and an
    // object that travels into a log or a record must not contain them.
    const { clientExtensionResults: _secret, ...response } = assertion;

    return { response, prfOutput: toBase64(first) };
}

function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
