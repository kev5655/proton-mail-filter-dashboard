import { useMemo, useState } from 'react';

import { bodyFor } from '@pms/demo';
import { buildFrameDocument, sanitizeMailHtml } from '@pms/mail-view';

import { useMailboxStatus } from '../mailbox.js';
import { protonMailUrl } from '../proton-link.js';
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
 *
 * **There is no body for real mail, and this says so.** Proton encrypts bodies end to end; their
 * metadata endpoint carries none, and nothing is stored locally. Until then this component called
 * `bodyFor(subject)` from the demo package for *every* message, which for a real subject fell
 * through to a placeholder reading "Diese Demo-Mail hat keinen eigenen Inhalt." So a real
 * advertising mail appeared to have no content and no images — and the check that remote images
 * stay blocked passed against a body that never existed. A test that passes for the wrong reason
 * is worse than one that fails.
 */
export function MailViewer({
    message,
    onClose,
}: {
    message: ListableMessage & { Sender?: { Name?: string }; NumAttachments?: number };
    onClose: () => void;
}): React.JSX.Element {
    const [allowImages, setAllowImages] = useState(false);
    const { source } = useMailboxStatus();

    // Only the demo has bodies, and not for every message even there. Inventing one was the whole
    // bug this component just had.
    const body = source === 'demo' ? bodyFor(message.Subject) : undefined;

    const sanitized = useMemo(
        () => sanitizeMailHtml(body?.html ?? '', { allowRemoteImages: allowImages }),
        [body?.html, allowImages]
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
                    {body === undefined && (
                        <div className="notice notice-info">
                            <strong>Kein Inhalt vorhanden.</strong>{' '}
                            {source === 'demo'
                                ? 'Für diese Demo-Mail wurde kein Text hinterlegt.'
                                : 'Proton verschlüsselt den Text einer Mail Ende zu Ende; über die Schnittstelle, aus der dieses Dashboard liest, kommt er nicht mit.'}{' '}
                            Angezeigt werden hier deshalb nur Absender, Betreff und Datum.
                            <div style={{ marginTop: 8 }}>
                                <a
                                    className="button button-secondary"
                                    href={protonMailUrl(message)}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                >
                                    Bei Proton öffnen
                                </a>
                            </div>
                        </div>
                    )}

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
                {body !== undefined && (
                <iframe
                    className="viewer-frame"
                    title={`Inhalt: ${message.Subject}`}
                    sandbox=""
                    srcDoc={frame}
                    referrerPolicy="no-referrer"
                />
                )}

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
