import { useMemo, useState } from 'react';

import { bodyFor } from '@pms/demo';
import { buildFrameDocument, sanitizeMailHtml } from '@pms/mail-view';

import type { ListableMessage } from './MailList.js';

/**
 * Reading a message.
 *
 * The body is sanitised, then rendered inside an iframe with `sandbox=""` and a Content-Security-
 * Policy that forbids every outbound request. Three independent layers, because a viewer that gets
 * this wrong does so silently — nothing looks broken when a tracking pixel loads.
 *
 * Remote images are off. That is not a preference: a one-pixel image tells the sender that the mail
 * was opened, when, and from which IP address, which is precisely the metadata a Proton account
 * exists to withhold. What was blocked and from which hosts is shown before anything is fetched, so
 * turning it on is a decision rather than a shrug.
 *
 * Links are listed with their real targets, because the sandbox stops them navigating and because a
 * link whose text disagrees with its destination should be visible, not discovered.
 */
export function MailViewer({
    message,
    onClose,
}: {
    message: ListableMessage & { Sender?: { Name?: string }; NumAttachments?: number };
    onClose: () => void;
}): React.JSX.Element {
    const [allowImages, setAllowImages] = useState(false);
    const body = bodyFor(message.Subject);

    const sanitized = useMemo(
        () => sanitizeMailHtml(body.html, { allowRemoteImages: allowImages }),
        [body.html, allowImages]
    );

    const frame = useMemo(
        () => buildFrameDocument(sanitized.html, allowImages),
        [sanitized.html, allowImages]
    );

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
                    {sanitized.blockedImageCount > 0 && !allowImages && (
                        <div className="notice notice-warning">
                            <strong>
                                {sanitized.blockedImageCount} externe{' '}
                                {sanitized.blockedImageCount === 1 ? 'Grafik' : 'Grafiken'} blockiert.
                            </strong>{' '}
                            Von {sanitized.blockedImageHosts.join(', ')}. Nachladen verrät dem
                            Absender, dass und wann du die Mail geöffnet hast — samt deiner
                            IP-Adresse.
                            <div style={{ marginTop: 8 }}>
                                <button
                                    type="button"
                                    className="button button-secondary"
                                    onClick={() => setAllowImages(true)}
                                >
                                    Grafiken für diese Mail laden
                                </button>
                            </div>
                        </div>
                    )}

                    {allowImages && (
                        <div className="notice notice-danger">
                            Grafiken werden geladen — von {sanitized.blockedImageHosts.join(', ')}.
                            Gilt nur für diese Mail und nur jetzt.
                            <div style={{ marginTop: 8 }}>
                                <button
                                    type="button"
                                    className="button button-secondary"
                                    onClick={() => setAllowImages(false)}
                                >
                                    Wieder blockieren
                                </button>
                            </div>
                        </div>
                    )}

                    {sanitized.removed.elements.length + sanitized.removed.eventHandlers > 0 && (
                        <div className="notice notice-info">
                            Aktive Inhalte entfernt:{' '}
                            {[
                                ...sanitized.removed.elements.map((tag) => `<${tag}>`),
                                sanitized.removed.eventHandlers > 0
                                    ? `${sanitized.removed.eventHandlers} Event-Handler`
                                    : undefined,
                                sanitized.removed.unsafeUrls > 0
                                    ? `${sanitized.removed.unsafeUrls} unsichere Links`
                                    : undefined,
                            ]
                                .filter((entry): entry is string => entry !== undefined)
                                .join(', ')}
                            . Die Mail wird dadurch verändert dargestellt — absichtlich.
                        </div>
                    )}
                </div>

                {/*
                 * sandbox="" grants nothing: no scripts, no forms, no navigation, no same-origin
                 * access. Combined with the CSP inside the document, a reference the sanitiser
                 * missed still cannot fetch or execute anything.
                 */}
                <iframe
                    className="viewer-frame"
                    title={`Inhalt: ${message.Subject}`}
                    sandbox=""
                    srcDoc={frame}
                    referrerPolicy="no-referrer"
                />

                {sanitized.links.length > 0 && (
                    <section className="viewer-links">
                        <h3>Links in dieser Mail</h3>
                        <p className="faint">
                            Anklicken ist im Betrachter deaktiviert. Hier steht, wohin sie
                            tatsächlich führen.
                        </p>
                        <ul className="link-list">
                            {sanitized.links.map((link, index) => (
                                <li key={`${link.href}-${index}`}>
                                    <span className="link-text">{link.text}</span>
                                    <code className={link.misleading ? 'link-target misleading' : 'link-target'}>
                                        {link.href}
                                    </code>
                                    {link.misleading && (
                                        <span className="badge badge-danger">Ziel weicht ab</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </div>
    );
}
