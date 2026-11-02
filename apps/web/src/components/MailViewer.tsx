import { useSettings } from '../llm.js';
import { protonMailUrl } from '../proton-link.js';
import type { ListableMessage } from './MailList.js';

/**
 * Reading a message — which today means reading everything *about* it.
 *
 * **There is no body, and this says so rather than filling the space.** Proton encrypts bodies end
 * to end; the metadata endpoint this dashboard reads carries none, and nothing is stored locally.
 *
 * It used to render one anyway. `bodyFor(subject)` from the demo package was called for *every*
 * message, so a real advertising mail matched nothing, fell through to a placeholder, and appeared
 * to have no content and no images — and the check that remote images stay blocked passed against a
 * body that never existed. A test that passes for the wrong reason is worse than one that fails.
 * With the demo gone there is no source of bodies at all, so the sanitiser, the sandboxed frame and
 * the image notices went with it rather than staying as scaffolding around nothing.
 *
 * `@pms/mail-view` is untouched and still tested on its own. It is what this screen mounts again on
 * the day a body can actually be fetched and decrypted — and bodies are hostile input, so that day
 * starts from the sanitiser rather than from an innerHTML.
 */
export function MailViewer({
    message,
    onClose,
}: {
    message: ListableMessage & { Sender?: { Name?: string }; NumAttachments?: number };
    onClose: () => void;
}): React.JSX.Element {
    const settings = useSettings();

    return (
        <div
            className="overlay"
            role="dialog"
            aria-modal="true"
            aria-label={message.Subject}
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="viewer">
                <header className="viewer-head">
                    <div className="stack">
                        <h2>{message.Subject}</h2>
                        <span className="faint">
                            {message.Sender.Address}
                            {message.NumAttachments !== undefined && message.NumAttachments > 0 && (
                                <> · {message.NumAttachments} Anhang</>
                            )}
                        </span>
                    </div>
                    <button type="button" className="button button-quiet" onClick={onClose}>
                        Schliessen
                    </button>
                </header>

                <div className="viewer-notices">
                    <div className="notice notice-info">
                        <strong>Kein Inhalt vorhanden.</strong> Proton verschlüsselt den Text einer
                        Mail Ende zu Ende; über die Schnittstelle, aus der dieses Dashboard liest,
                        kommt er nicht mit. Angezeigt werden hier deshalb nur Absender, Betreff und
                        Datum.
                        <div style={{ marginTop: 8 }}>
                            <a
                                className="button button-secondary"
                                href={protonMailUrl(message, settings.proton)}
                                target="_blank"
                                rel="noreferrer noopener"
                            >
                                Bei Proton öffnen
                            </a>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
}
