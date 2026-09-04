import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
    createCloudProvider,
    createOllamaProvider,
    NO_PROVIDER,
    presetById,
    type LlmProvider,
} from '@pms/llm';

import { log } from './log.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';

/**
 * Which language model is in play, and whether it is answering.
 *
 * Every feature that uses one has an alternative that does not, and the alternative is always the
 * derived, checkable thing: the rule structure rather than the prose about it, the matcher's list
 * rather than the model's claim about what it caught. So an unreachable model is never an error
 * state — it is a missing convenience, said plainly where the convenience would have been.
 *
 * `createOllamaProvider` had never been called anywhere in this project. It existed, it was tested,
 * and the one dialog that needs a model reached past it for the demo stand-in — so configuring a
 * model changed nothing. That is what this context is for.
 */

export type ModelState = 'disabled' | 'checking' | 'available' | 'unavailable';

interface ModelContext {
    provider: LlmProvider;
    state: ModelState;
    settings: Settings;
    update: (next: Settings) => void;
    recheck: () => void;
}

const Context = createContext<ModelContext | undefined>(undefined);

export function ModelProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const [settings, setSettings] = useState<Settings>(() => loadSettings());
    const [state, setState] = useState<ModelState>('checking');
    const [attempt, setAttempt] = useState(0);

    const provider = useMemo<LlmProvider>(() => {
        switch (settings.llm.mode) {
            case 'ollama':
                return createOllamaProvider({ baseUrl: settings.llm.baseUrl, model: settings.llm.model });
            case 'cloud': {
                const preset = presetById(settings.llm.cloud.provider);
                return createCloudProvider({
                    dialect: preset?.dialect ?? 'openai',
                    // A preset carries its own address; only „eigene Adresse" uses the field.
                    baseUrl:
                        preset === undefined || preset.baseUrl === ''
                            ? settings.llm.cloud.baseUrl
                            : preset.baseUrl,
                    apiKey: settings.llm.cloud.apiKey,
                    model: settings.llm.cloud.model,
                });
            }
            default:
                return NO_PROVIDER;
        }
    }, [settings.llm.mode, settings.llm.baseUrl, settings.llm.model, settings.llm.cloud]);

    useEffect(() => {
        if (settings.llm.mode === 'off') {
            setState('disabled');
            return;
        }

        let cancelled = false;
        setState('checking');

        void provider
            .isAvailable()
            .then((available) => {
                if (cancelled) {
                    return;
                }
                setState(available ? 'available' : 'unavailable');
                if (!available) {
                    // The mode only. A base URL can name a host somebody would rather not paste
                    // into a bug report, and this log is built to be handed over unedited.
                    log('warn', 'llm.unavailable', { mode: settings.llm.mode });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setState('unavailable');
                }
            });

        return () => {
            cancelled = true;
        };
    }, [provider, settings.llm.mode, attempt]);

    const update = useCallback((next: Settings) => {
        setSettings(next);
        saveSettings(next);
    }, []);

    const recheck = useCallback(() => {
        setAttempt((current) => current + 1);
    }, []);

    const value = useMemo<ModelContext>(
        () => ({ provider, state, settings, update, recheck }),
        [provider, state, settings, update, recheck]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useModel(): ModelContext {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useModel outside ModelProvider');
    }
    return value;
}

/** Just the settings, for the many places that need a page size or a Proton host. */
export function useSettings(): Settings {
    return useModel().settings;
}
