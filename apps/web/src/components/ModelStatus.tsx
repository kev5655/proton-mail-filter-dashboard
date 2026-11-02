import { useModel } from '../llm.js';
import { useAppState } from '../state.js';

/**
 * Says whether a language model is answering, wherever one would have been used.
 *
 * Shown next to the feature rather than once in a corner, because "why is there no explanation
 * here" is a question asked at the explanation, not at a status bar. And it never blocks: every
 * model feature in this project sits below something derived and checkable, so the honest message
 * is that the derived part still holds.
 */
export function ModelStatus({ what }: { what: string }): React.JSX.Element | null {
    const { state, settings } = useModel();
    const { goTo } = useAppState();

    if (state === 'available') {
        return null;
    }

    if (state === 'checking') {
        return <p className="faint">Sprachmodell wird geprüft …</p>;
    }

    return (
        <p className="notice notice-info">
            {state === 'disabled'
                ? `Kein Sprachmodell eingerichtet, deshalb ${what} nicht.`
                : `Sprachmodell nicht erreichbar (${settings.llm.mode === 'ollama' ? 'Ollama' : settings.llm.mode}), deshalb ${what} nicht.`}{' '}
            Die abgeleitete Struktur gilt trotzdem — sie kommt aus dem Compiler und dem Matcher, nicht
            aus einem Modell.{' '}
            <button type="button" className="value-chip value-chip-link" onClick={() => goTo({ page: 'settings' })}>
                Einrichten
            </button>
        </p>
    );
}
