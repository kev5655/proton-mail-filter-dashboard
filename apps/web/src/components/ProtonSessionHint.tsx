import { useAppState } from '../state.js';
import { Info } from './Info.js';

/**
 * The way back, offered next to the error that needs it.
 *
 * „Proton hat `GET mail/v4/filters` mit HTTP 401 abgelehnt: Invalid access token" is an accurate
 * sentence and a dead end: it says what happened and nothing about what to do, and the thing to do
 * is on a different screen behind a tab. So the error carries the button.
 *
 * It is deliberately narrow. Only a failure that is actually about the session gets it — a stale
 * folder, a refused write or a schema mismatch are not fixed by signing in again, and offering the
 * same button for every error would make it mean nothing.
 */

/** Error codes that mean „this session no longer works", as opposed to „this change did not". */
const SESSION_CODES = new Set([
    'PROTON_AUTH_FAILED',
    'SESSION_DISCONNECTED',
    'ACCOUNT_LOCKED',
    'SERVER_LOGIN_UNAVAILABLE',
]);

/**
 * Whether an error is about the connection to Proton.
 *
 * The code first, because it is stable. The HTTP status is checked as well because
 * `PROTON_API_ERROR` is one code covering every refusal Proton makes, and a 401 inside it is the
 * exact case this exists for — the message is the only place that distinguishes it.
 */
export function isSessionProblem(code: string | undefined, message: string | undefined): boolean {
    if (code !== undefined && SESSION_CODES.has(code)) {
        return true;
    }
    if (code !== 'PROTON_API_ERROR') {
        return false;
    }
    return /\bHTTP 401\b|Invalid access token|Invalid refresh token/i.test(message ?? '');
}

export function ProtonSessionHint({
    code,
    message,
}: {
    code: string | undefined;
    message: string | undefined;
}): React.JSX.Element | null {
    const { goTo } = useAppState();

    if (!isSessionProblem(code, message)) {
        return null;
    }

    return (
        <p className="notice notice-warning row">
            {/* The mark sits on the sentence it explains, not beside the button. */}
            <span>
                <strong>Die Verbindung zu Proton gilt nicht mehr.</strong>{' '}
                <Info label="Was das bedeutet">
                Das Zugriffstoken ist abgelaufen oder wurde beendet. An deinem Postfach ist dadurch
                nichts kaputt — es braucht eine neue Anmeldung, danach lässt sich dieselbe Änderung
                    noch einmal vormerken.
                </Info>
            </span>
            <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                    goTo({ page: 'settings', focusConnection: true });
                }}
            >
                Neu verbinden
            </button>
        </p>
    );
}
