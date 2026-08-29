/**
 * Making a mail body safe to display.
 *
 * Mail is hostile input. It arrives from strangers, it is HTML, and the sender's goal is often
 * precisely to learn something about the reader. Three defences are applied, and each is written on
 * the assumption that the other two have failed:
 *
 *  1. **This sanitiser** removes anything executable and neutralises every remote reference.
 *  2. The viewer renders the result in an **iframe with `sandbox=""`**, so no script can run even if
 *     one survived, and no navigation can be triggered.
 *  3. That iframe carries a **Content-Security-Policy** forbidding every outbound request, so a
 *     missed `src` fetches nothing.
 *
 * Remote images are the specific reason images are off by default. A one-pixel transparent image is
 * how a sender learns that a message was opened, when, and from which IP address — with Proton in
 * front of the mailbox, loading it hands back exactly the metadata the account exists to protect.
 * So they are blocked, the hosts are named, and turning them on is a per-message decision.
 */

const FORBIDDEN_ELEMENTS = new Set([
    'SCRIPT',
    'STYLE',
    'IFRAME',
    'FRAME',
    'FRAMESET',
    'OBJECT',
    'EMBED',
    'APPLET',
    'LINK',
    'META',
    'BASE',
    'FORM',
    'INPUT',
    'BUTTON',
    'TEXTAREA',
    'SELECT',
    'AUDIO',
    'VIDEO',
    'SOURCE',
    'TRACK',
    // SVG can carry script and foreignObject; it is not worth the parsing surface for mail.
    'SVG',
    'MATH',
    'PORTAL',
]);

/** Attributes safe to keep. Everything else is dropped, which is the only defensible default. */
const ALLOWED_ATTRIBUTES = new Set([
    'href',
    'src',
    'alt',
    'title',
    'width',
    'height',
    'colspan',
    'rowspan',
    'align',
    'style',
    'class',
    'dir',
    'lang',
]);

/** Only these can appear in a `style` attribute; anything else can load or position content. */
const ALLOWED_STYLE_PROPERTIES = new Set([
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'font-style',
    'font-family',
    'text-align',
    'text-decoration',
    'padding',
    'padding-top',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'margin',
    'margin-top',
    'margin-bottom',
    'margin-left',
    'margin-right',
    'border',
    'border-top',
    'border-bottom',
    'border-collapse',
    'max-width',
    'width',
    'line-height',
]);

const SAFE_URL = /^(https?:|mailto:|tel:)/i;

/**
 * Inline images are safe: they fetch nothing and cannot report anything back. Only images —
 * `data:text/html` is a script delivery mechanism and must still be rejected.
 */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;

/** A 1x1 transparent gif, so a blocked image collapses instead of showing a broken icon. */
const BLANK_IMAGE =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface SanitizeOptions {
    /** Off by default, and only ever turned on by an explicit action for one message. */
    allowRemoteImages?: boolean;
}

export interface SanitizedMail {
    html: string;
    /** Hosts the message wanted to load images from, deduplicated. */
    blockedImageHosts: string[];
    blockedImageCount: number;
    /**
     * Every link, with its real target.
     *
     * Surfaced separately because the sandbox stops links from navigating, and because a link whose
     * text says one thing and whose target says another is the oldest trick in the message.
     */
    links: Array<{ text: string; href: string; misleading: boolean }>;
    /** What was removed, so the viewer can say so rather than silently altering the message. */
    removed: { elements: string[]; eventHandlers: number; unsafeUrls: number };
}

export function sanitizeMailHtml(html: string, options: SanitizeOptions = {}): SanitizedMail {
    const document_ = new DOMParser().parseFromString(html, 'text/html');
    const body = document_.body;

    const blockedHosts = new Set<string>();
    const removedElements = new Set<string>();
    const links: SanitizedMail['links'] = [];
    let blockedImageCount = 0;
    let eventHandlers = 0;
    let unsafeUrls = 0;

    // Snapshot first: removing nodes while walking a live collection skips siblings.
    for (const element of [...body.querySelectorAll('*')]) {
        // Upper-cased explicitly: `tagName` is upper-case for HTML elements but keeps its original
        // case in the SVG and MathML namespaces, so a plain comparison lets `<svg>` and every
        // element inside it straight through.
        const tag = element.tagName.toUpperCase();

        if (FORBIDDEN_ELEMENTS.has(tag)) {
            removedElements.add(tag.toLowerCase());
            element.remove();
            continue;
        }

        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();

            // Every `on*` attribute is executable, including ones invented after this was written.
            if (name.startsWith('on')) {
                eventHandlers++;
                element.removeAttribute(attribute.name);
                continue;
            }

            if (!ALLOWED_ATTRIBUTES.has(name)) {
                element.removeAttribute(attribute.name);
                continue;
            }

            if (name === 'style') {
                element.setAttribute('style', filterStyle(attribute.value));
                continue;
            }

            if (name === 'href' || name === 'src') {
                const url = attribute.value.trim();
                const inlineImage = name === 'src' && SAFE_DATA_IMAGE.test(url);
                if (!SAFE_URL.test(url) && !inlineImage) {
                    // javascript:, data:text/html, vbscript:, and anything else that is not
                    // plainly a fetch of something inert.
                    unsafeUrls++;
                    element.removeAttribute(attribute.name);
                }
            }
        }

        if (tag === 'IMG') {
            handleImage(element, options.allowRemoteImages === true, blockedHosts, () => {
                blockedImageCount++;
            });
        }

        if (tag === 'A') {
            handleLink(element, links);
        }
    }

    return {
        html: body.innerHTML,
        blockedImageHosts: [...blockedHosts].sort(),
        blockedImageCount,
        links,
        removed: { elements: [...removedElements].sort(), eventHandlers, unsafeUrls },
    };
}

function handleImage(
    element: Element,
    allowRemote: boolean,
    blockedHosts: Set<string>,
    countBlocked: () => void
): void {
    const source = element.getAttribute('src');
    if (source === null || source.startsWith('data:')) {
        return;
    }

    const host = hostOf(source);
    if (host === undefined) {
        element.removeAttribute('src');
        return;
    }

    blockedHosts.add(host);
    if (allowRemote) {
        return;
    }

    countBlocked();
    element.setAttribute('src', BLANK_IMAGE);
    element.setAttribute('data-blocked-host', host);
}

function handleLink(element: Element, links: SanitizedMail['links']): void {
    const href = element.getAttribute('href');
    if (href === null) {
        return;
    }

    const text = (element.textContent ?? '').trim();
    const target = hostOf(href);

    // The text claims one destination and the href goes somewhere else. Not proof of anything, but
    // the reader should be told rather than left to notice.
    const claimed = hostOf(text.startsWith('http') ? text : `https://${text}`);
    const misleading = claimed !== undefined && target !== undefined && claimed !== target;

    links.push({ text: text === '' ? href : text, href, misleading });

    // The sandbox blocks navigation anyway; these matter if the markup is ever used elsewhere.
    element.setAttribute('rel', 'noopener noreferrer nofollow');
    element.setAttribute('target', '_blank');
}

function hostOf(url: string): string | undefined {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return undefined;
    }
}

function filterStyle(value: string): string {
    return value
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => {
            const [property, ...rest] = declaration.split(':');
            if (property === undefined || rest.length === 0) {
                return false;
            }
            const body = rest.join(':').toLowerCase();
            // `url(...)` in CSS is a remote fetch by another name; `expression(...)` is executable.
            if (body.includes('url(') || body.includes('expression(')) {
                return false;
            }
            return ALLOWED_STYLE_PROPERTIES.has(property.trim().toLowerCase());
        })
        .join('; ');
}

/**
 * The document handed to the sandboxed iframe.
 *
 * The CSP is the layer that does not depend on the sanitiser being complete: `default-src 'none'`
 * means a reference the sanitiser missed still fetches nothing. When images are allowed it opens
 * exactly one hole — `img-src` over https — and nothing else.
 */
export function buildFrameDocument(sanitizedHtml: string, allowRemoteImages: boolean): string {
    const imagePolicy = allowRemoteImages ? "img-src https: data:" : "img-src data:";

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; ${imagePolicy}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'" />
<style>
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #1b1340; background: #fff; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  img[data-blocked-host] { min-width: 24px; min-height: 24px; border: 1px dashed #c9c6d1; border-radius: 4px; background: #f5f5f7; }
  table { max-width: 100%; }
  a { color: #6d4aff; }
</style>
</head>
<body>${sanitizedHtml}</body>
</html>`;
}
