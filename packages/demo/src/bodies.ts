/**
 * Bodies for the demo mail.
 *
 * Written to exercise the viewer rather than to look pretty, so several of them contain exactly the
 * things that make displaying mail dangerous: tracking pixels, remote images from several hosts,
 * a script tag, an inline event handler, and a link whose text disagrees with its target. If the
 * viewer renders those without complaint on this data, it would do the same with real mail.
 *
 * A note on where bodies come from in the real tool: they are the one thing Proton does encrypt end
 * to end, so unlike subject and sender they cannot be read from the metadata endpoint. Showing a
 * real body needs either the Bridge (M4) or per-message decryption, which is a decision still to be
 * made. The viewer is built now so that decision is made against a working interface.
 */

export interface DemoBody {
    /** Rendered as HTML, sanitised and sandboxed. */
    html: string;
    /** Hosts the message wants to fetch images from. Shown to the user before anything is loaded. */
    remoteHosts: string[];
}

const SIGNATURE = `
    <hr style="border:0;border-top:1px solid #ddd;margin:24px 0" />
    <p style="color:#888;font-size:12px">
        Diese Nachricht wurde automatisch erstellt. Bitte antworten Sie nicht darauf.
    </p>`;

export const BODIES: Record<string, DemoBody> = {
    'Neue Anmeldung bei deinem Konto': {
        remoteHosts: ['tracking.example-cloud.com'],
        html: `
            <h2 style="margin:0 0 12px">Neue Anmeldung erkannt</h2>
            <p>Jemand hat sich soeben in deinem Konto angemeldet.</p>
            <table style="border-collapse:collapse;margin:16px 0">
                <tr><td style="padding:4px 16px 4px 0;color:#666">Gerät</td><td>Chrome auf Windows</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#666">Ort</td><td>Zürich, Schweiz</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#666">Zeit</td><td>heute, 09:14</td></tr>
            </table>
            <p>Warst du das nicht? <a href="https://phishing.example.invalid/reset">Konto sichern</a></p>
            <!-- A tracking pixel: one transparent image whose only purpose is to report that the
                 message was opened, along with the reader's IP address. -->
            <img src="https://tracking.example-cloud.com/open?id=9f3c" width="1" height="1" alt="" />
            ${SIGNATURE}`,
    },

    'Neuigkeiten zu deinem Konto': {
        remoteHosts: ['cdn.example-cloud.com', 'tracking.example-cloud.com'],
        html: `
            <img src="https://cdn.example-cloud.com/banner-wide.png" alt="Beispielbanner" style="max-width:100%" />
            <h2>Neue Funktionen für dein Konto</h2>
            <p>Wir haben einiges verbessert. Schau dir an, was neu ist.</p>
            <p><a href="https://example-cloud.com/news">Mehr erfahren</a></p>
            <img src="https://tracking.example-cloud.com/open?id=aa12" width="1" height="1" alt="" />
            ${SIGNATURE}`,
    },

    'Angebot der Woche': {
        remoteHosts: ['images.versandhaus.example', 'pixel.werbenetzwerk.example'],
        html: `
            <img src="https://images.versandhaus.example/header.jpg" alt="Angebot" style="max-width:100%" />
            <h2>Nur diese Woche</h2>
            <p>Auf alles, was Sie schon immer nicht gebraucht haben.</p>
            <!-- Deliberately hostile: a script tag and an inline handler. Neither may ever run. -->
            <script>window.alert('Dies darf niemals ausgeführt werden');</script>
            <p onmouseover="window.alert('auch das nicht')">Zum Shop</p>
            <p><a href="https://ganz-woanders.example/klick">https://versandhaus.example/angebote</a></p>
            <img src="https://pixel.werbenetzwerk.example/t.gif?u=4711" width="1" height="1" alt="" />
            ${SIGNATURE}`,
    },

    'Ihre Rechnung': {
        remoteHosts: [],
        html: `
            <p>Guten Tag</p>
            <p>Anbei finden Sie Ihre Rechnung als PDF. Der Betrag wird in 30 Tagen fällig.</p>
            <p>Freundliche Grüsse<br />Ihre Krankenkasse</p>
            ${SIGNATURE}`,
    },

    'Ihr Ticket': {
        remoteHosts: [],
        html: `
            <h2>Buchungsbestätigung</h2>
            <p>Ihre Fahrkarte ist gebucht. Bitte zeigen Sie den QR-Code beim Einsteigen vor.</p>
            <p style="font-family:monospace;background:#f4f4f4;padding:8px">Zürich HB → Bern · Wagen 4, Platz 62</p>
            ${SIGNATURE}`,
    },

    'Lohnabrechnung': {
        remoteHosts: [],
        html: `
            <p>Guten Tag</p>
            <p>Ihre Lohnabrechnung für den laufenden Monat liegt als Anhang bei.</p>
            <p>Personalabteilung</p>`,
    },
};

const FALLBACK: DemoBody = {
    remoteHosts: [],
    html: `<p>Diese Demo-Mail hat keinen eigenen Inhalt.</p>`,
};

/** Bodies are keyed by a subject prefix, so generated variations share one body. */
export function bodyFor(subject: string): DemoBody {
    const match = Object.keys(BODIES).find((key) => subject.startsWith(key));
    return match === undefined ? FALLBACK : (BODIES[match] as DemoBody);
}
