import { Component, type ErrorInfo, type ReactNode } from 'react';

import { buildIncidentReport, log } from '../log.js';

/**
 * Catch a crashing subtree instead of losing the whole application.
 *
 * React unmounts the entire root when a render throws, so before this existed one broken screen
 * left a white page with no sidebar and no way back — which is exactly what happened on
 * „Protokoll". A boundary around the page switch keeps the navigation alive, so the worst a broken
 * screen can do is be one broken screen.
 *
 * What reaches the log is the error's *name* and, for an `AppError`, its code. Never the message:
 * a message can quote a subject line or a folder name, and the log exists to be pasted into a chat
 * window without anyone having to redact it first.
 */

interface Props {
    children: ReactNode;
    /** Named in the log and in the panel, so a report says which part fell over. */
    area: string;
    /** Changing this remounts the subtree — the page id, so navigating away clears the error. */
    resetKey?: string | undefined;
}

interface State {
    error: Error | undefined;
    copied: boolean;
}

function codeOf(error: unknown): string | undefined {
    if (error !== null && typeof error === 'object' && 'code' in error) {
        const code = (error as { code: unknown }).code;
        return typeof code === 'string' ? code : undefined;
    }
    return undefined;
}

export class ErrorBoundary extends Component<Props, State> {
    override state: State = { error: undefined, copied: false };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    override componentDidUpdate(previous: Props): void {
        // Navigating away is the most natural recovery, so it should not need a button.
        if (previous.resetKey !== this.props.resetKey && this.state.error !== undefined) {
            this.setState({ error: undefined, copied: false });
        }
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        const code = codeOf(error);
        log('error', 'ui.crash', {
            area: this.props.area,
            name: error.name,
            ...(code === undefined ? {} : { code }),
            // A boolean, not the stack: whether React could attribute it is useful, the component
            // names are not worth the risk of a subject line appearing in a prop somewhere.
            attributed: typeof info.componentStack === 'string' && info.componentStack !== '',
        });
    }

    private readonly copyReport = (): void => {
        void navigator.clipboard
            .writeText(buildIncidentReport('0.1.0'))
            .then(() => {
                this.setState({ copied: true });
            })
            .catch(() => {
                // Clipboard access is refused outside a secure context. Not worth a second failure.
                this.setState({ copied: false });
            });
    };

    override render(): ReactNode {
        const { error, copied } = this.state;
        if (error === undefined) {
            return this.props.children;
        }

        const code = codeOf(error);

        return (
            <div className="card notice-danger" role="alert">
                <h2>Hier ist etwas abgestürzt</h2>
                <p>
                    Der Bereich „{this.props.area}" liess sich nicht darstellen. Der Rest des
                    Dashboards läuft weiter — links kannst du auf einen anderen Bildschirm wechseln.
                </p>
                <p className="faint">
                    {error.name}
                    {code === undefined ? '' : ` · ${code}`}
                </p>
                <p>
                    Am Konto hat sich dadurch nichts geändert. Nichts wird ohne Bestätigung
                    geschrieben, und ein Absturz kann keine Bestätigung geben.
                </p>
                <div className="row">
                    <button
                        type="button"
                        className="button"
                        onClick={() => {
                            this.setState({ error: undefined, copied: false });
                        }}
                    >
                        Nochmal versuchen
                    </button>
                    <button type="button" className="button button-quiet" onClick={this.copyReport}>
                        {copied ? 'Bericht kopiert' : 'Bericht kopieren'}
                    </button>
                </div>
            </div>
        );
    }
}
