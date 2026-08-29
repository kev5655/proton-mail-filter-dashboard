import { AppError } from '@pms/core/errors';

/**
 * Checks that a credential actually arrived.
 *
 * This module exists because of a specific failure: a broken prompt returned an empty string, the
 * code passed it along as a password, and Proton counted the result as a failed login attempt.
 * Repeat that a few times and the account gets locked — which is exactly what happened.
 *
 * The lesson generalises past that one bug. Any source of a secret can hand back nothing: a
 * prompt that was skipped, a vault entry with the wrong field name, a CLI that printed a warning to
 * stdout instead of a value. None of those look like errors at the call site, and all of them cost
 * a login attempt if they reach Proton. So nothing gets used before it has been checked.
 *
 * The checks describe values, never quote them. An error message containing the password would
 * defeat the point.
 */

export interface CredentialOrigin {
    /** Where it came from, for the error message: "1Password (Kevin Private/Proton)". */
    source: string;
    /** What was being fetched: "Passwort", "Benutzername", "2FA-Code". */
    label: string;
}

/** Reject anything empty or whitespace-only, and return the trimmed value. */
export function requirePresent(value: string | undefined, origin: CredentialOrigin): string {
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') {
        throw new AppError('CREDENTIALS_EMPTY', {
            message: `${origin.label} kam leer zurück (Quelle: ${origin.source}).`,
            hint:
                'Nichts wurde an Proton geschickt. Ein leerer Wert würde als Fehlversuch zählen und ' +
                'zur Kontosperre beitragen. Bitte die Quelle prüfen — Feldname, Eintrag, Tresor.',
            context: { source: origin.source, label: origin.label },
        });
    }
    return trimmed;
}

/**
 * A username that is obviously not one.
 *
 * Kept loose on purpose: Proton accounts can be an address or a bare username, and rejecting a
 * legitimate one would be worse than passing a doubtful one. This catches the failure that actually
 * occurs — a CLI printing a message where a value was expected.
 */
export function requireUsername(value: string | undefined, origin: CredentialOrigin): string {
    const username = requirePresent(value, origin);

    if (username.includes('\n') || username.length > 254 || /\s/.test(username)) {
        throw new AppError('CREDENTIALS_MALFORMED', {
            message: `${origin.label} sieht nicht wie ein Benutzername aus (Quelle: ${origin.source}).`,
            hint: 'Vermutlich stand im Feld eine Meldung statt eines Werts.',
            context: { source: origin.source, label: origin.label, length: username.length },
        });
    }
    return username;
}

/**
 * A password is only checked for presence and for signs of being the wrong thing entirely.
 *
 * No complexity rules: it is not ours to judge, and a false rejection here locks the user out of
 * their own tool.
 */
export function requirePassword(value: string | undefined, origin: CredentialOrigin): string {
    const password = requirePresent(value, origin);

    if (password.includes('\n')) {
        throw new AppError('CREDENTIALS_MALFORMED', {
            message: `${origin.label} enthält Zeilenumbrüche (Quelle: ${origin.source}).`,
            hint: 'Das deutet auf mehrzeilige Ausgabe hin, nicht auf ein Passwort.',
            context: { source: origin.source, label: origin.label, lines: password.split('\n').length },
        });
    }
    return password;
}

/**
 * A TOTP code, checked strictly.
 *
 * Strict here is safe: the format is fixed, and a wrong code costs a login attempt just like a
 * wrong password. This is also where an expired 1Password session shows up — `op` prints an error
 * that is emphatically not six digits.
 */
export function requireTotp(value: string | undefined, origin: CredentialOrigin): string {
    const code = requirePresent(value, origin).replace(/\s/g, '');

    if (!/^\d{6,8}$/.test(code)) {
        throw new AppError('CREDENTIALS_MALFORMED', {
            message: `${origin.label} ist kein gültiger 2FA-Code (Quelle: ${origin.source}).`,
            hint:
                'Erwartet werden 6 bis 8 Ziffern. Kam etwas anderes, hat die Quelle vermutlich eine ' +
                'Fehlermeldung geliefert statt eines Codes.',
            context: { source: origin.source, label: origin.label, length: code.length },
        });
    }
    return code;
}
