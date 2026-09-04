import { DEFAULT_LINK_CONFIG, type ProtonLinkConfig } from './proton-link.js';

/**
 * The handful of choices the dashboard remembers.
 *
 * In `localStorage`, and that is a deliberate limit rather than the easy option. The server is
 * read-only by construction and has to stay that way, so it cannot hold settings; and what is here
 * is neither a secret nor mailbox data — a base URL, a model name, a host, an account index. If
 * something ever belongs here that would be a problem to leave in a browser's storage, it belongs
 * somewhere else instead.
 *
 * Read defensively, field by field. A stored value from an older version, or one edited by hand,
 * must not stop the dashboard starting: an unusable field falls back to its default and the rest
 * survives.
 */

export type LlmMode = 'off' | 'demo' | 'ollama';

export interface Settings {
    version: 1;
    llm: {
        mode: LlmMode;
        baseUrl: string;
        model: string;
    };
    proton: ProtonLinkConfig;
    display: {
        /** Rows per page in every mail list. */
        pageSize: number;
    };
    sync: {
        /**
         * How often `pnpm serve` refreshes the copy, in minutes. `0` turns it off.
         *
         * Held here and carried to the server with the next manual sync, because the server has no
         * writable configuration of its own and is not getting one for a timer. It therefore lasts
         * as long as that `pnpm serve` process — the settings screen says so, since a value that
         * looks permanent and is gone after Ctrl+C is worse than an honest sentence.
         */
        autoSyncMinutes: number;
    };
}

/**
 * `off` rather than `demo` for the model.
 *
 * The stand-in provider answers instantly and plausibly, which is exactly what makes it the wrong
 * default once a real mailbox is on screen: generated text that looks like a model's judgement but
 * is a lookup table. Off says so.
 */
export const DEFAULTS: Settings = {
    version: 1,
    /*
     * `/ollama` rather than `http://127.0.0.1:11434`, and it matters.
     *
     * Ollama answers only requests whose `Origin` it was told to allow, and a page on
     * `localhost:5173` is not one by default — so the probe failed with a network error that looks
     * exactly like "nothing is listening", and the settings page told people their running model
     * was unreachable. The relative path goes through the dev server's proxy, so the browser is
     * asking its own origin and the question never arises.
     *
     * An absolute URL still works and is still the right answer for an Ollama on another machine.
     */
    llm: { mode: 'off', baseUrl: '/ollama', model: 'qwen2.5:7b' },
    proton: DEFAULT_LINK_CONFIG,
    display: { pageSize: 10 },
    sync: { autoSyncMinutes: 5 },
};

const KEY = 'pms.settings';

export function loadSettings(): Settings {
    let stored: unknown;
    try {
        const raw = window.localStorage.getItem(KEY);
        stored = raw === null ? undefined : JSON.parse(raw);
    } catch {
        // Unparseable, or storage refused — a private window, a disabled setting. Defaults are a
        // working dashboard; a thrown error here would be a blank one.
        return DEFAULTS;
    }

    if (stored === null || typeof stored !== 'object') {
        return DEFAULTS;
    }

    const value = stored as Partial<Settings>;
    return {
        version: 1,
        llm: {
            mode: oneOf(value.llm?.mode, ['off', 'demo', 'ollama'], DEFAULTS.llm.mode),
            // The old default, carried forward from a copy saved before the proxy existed. Left
            // as it is, it keeps failing on Ollama's origin check for a reason nobody can see from
            // the screen; there is nothing to lose by moving it to the path that works.
            baseUrl: migrateBaseUrl(text(value.llm?.baseUrl, DEFAULTS.llm.baseUrl)),
            model: text(value.llm?.model, DEFAULTS.llm.model),
        },
        proton: {
            host: text(value.proton?.host, DEFAULTS.proton.host),
            account: whole(value.proton?.account, DEFAULTS.proton.account),
        },
        display: {
            pageSize: Math.min(100, Math.max(5, whole(value.display?.pageSize, DEFAULTS.display.pageSize))),
        },
        sync: {
            // 0 is off and is meant; anything else is bounded the same way the server bounds it, so
            // a value stored here cannot be one the server would refuse.
            autoSyncMinutes: clampInterval(whole(value.sync?.autoSyncMinutes, DEFAULTS.sync.autoSyncMinutes)),
        },
    };
}

export function saveSettings(next: Settings): void {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // Saving is a convenience; refusing to work because it failed would not be.
    }
}

function clampInterval(minutes: number): number {
    return minutes <= 0 ? 0 : Math.min(1440, Math.max(1, minutes));
}

/** The address the dashboard used to be shipped with, replaced by the one that reaches Ollama. */
const SUPERSEDED_OLLAMA_URLS = new Set(['http://127.0.0.1:11434', 'http://localhost:11434']);

function migrateBaseUrl(value: string): string {
    return SUPERSEDED_OLLAMA_URLS.has(value.replace(/\/+$/, '')) ? DEFAULTS.llm.baseUrl : value;
}

function text(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function whole(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
