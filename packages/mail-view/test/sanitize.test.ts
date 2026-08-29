// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { buildFrameDocument, sanitizeMailHtml } from '../src/sanitize.js';

/**
 * Mail is hostile input, so this suite is written as an attacker would: every test is an attempt to
 * get something through, and passing means the attempt failed.
 *
 * The tracking-pixel cases matter most. With Proton in front of the mailbox, loading a remote image
 * hands the sender the reader's IP address and the exact time they opened the message — the very
 * metadata the account exists to keep. A viewer that quietly fetches it undoes the point of the
 * product it is attached to.
 */

describe('executable content', () => {
    it('removes script tags', () => {
        const result = sanitizeMailHtml('<p>Hallo</p><script>window.alert(1)</script>');

        expect(result.html).not.toContain('script');
        expect(result.html).toContain('Hallo');
        expect(result.removed.elements).toContain('script');
    });

    it('removes every on* handler, including ones nobody listed', () => {
        const result = sanitizeMailHtml(
            '<p onmouseover="x()" onfocus="y()" onsomethingnewin2030="z()">Text</p>'
        );

        expect(result.html).not.toMatch(/on[a-z]+=/i);
        expect(result.removed.eventHandlers).toBe(3);
    });

    it('drops javascript: and data: urls on links', () => {
        const result = sanitizeMailHtml(
            '<a href="javascript:alert(1)">a</a><a href="data:text/html,<script>1</script>">b</a>'
        );

        expect(result.html).not.toContain('javascript:');
        expect(result.html).not.toContain('data:text/html');
        expect(result.removed.unsafeUrls).toBe(2);
    });

    it('removes iframes, objects and forms', () => {
        const result = sanitizeMailHtml(
            '<iframe src="https://x.example"></iframe><object data="x"></object><form action="https://x.example"><input /></form>'
        );

        expect(result.html).not.toMatch(/iframe|object|form|input/);
    });

    it('removes svg, which can carry script', () => {
        const result = sanitizeMailHtml('<svg><script>alert(1)</script></svg>');
        expect(result.html).not.toContain('svg');
    });

    it('strips css that can fetch or execute', () => {
        const result = sanitizeMailHtml(
            '<p style="color:red;background-image:url(https://tracker.example/x.png);width:expression(alert(1))">x</p>'
        );

        expect(result.html).toMatch(/color:\s*red/);
        expect(result.html).not.toContain('url(');
        expect(result.html).not.toContain('expression(');
    });

    it('drops attributes nobody needs, like id and event-bearing data attributes', () => {
        const result = sanitizeMailHtml('<p id="x" ping="https://t.example" contenteditable="true">y</p>');

        expect(result.html).not.toContain('ping=');
        expect(result.html).not.toContain('contenteditable');
    });
});

describe('remote images', () => {
    const trackingPixel =
        '<p>Text</p><img src="https://tracking.example/open?id=9f3c" width="1" height="1" />';

    it('blocks them by default and names the host', () => {
        const result = sanitizeMailHtml(trackingPixel);

        expect(result.html).not.toContain('tracking.example/open');
        expect(result.html).toContain('data:image/gif');
        expect(result.blockedImageHosts).toEqual(['tracking.example']);
        expect(result.blockedImageCount).toBe(1);
    });

    it('loads them only when explicitly allowed', () => {
        const result = sanitizeMailHtml(trackingPixel, { allowRemoteImages: true });

        expect(result.html).toContain('https://tracking.example/open');
        expect(result.blockedImageCount).toBe(0);
        // Still reported, so the user can see what was fetched on their behalf.
        expect(result.blockedImageHosts).toEqual(['tracking.example']);
    });

    it('reports each distinct host once', () => {
        const result = sanitizeMailHtml(
            '<img src="https://a.example/1.png"><img src="https://a.example/2.png"><img src="https://b.example/3.png">'
        );

        expect(result.blockedImageHosts).toEqual(['a.example', 'b.example']);
        expect(result.blockedImageCount).toBe(3);
    });

    it('leaves inline images alone, since they fetch nothing', () => {
        const inline = '<img src="data:image/png;base64,iVBORw0KGgo=" />';
        expect(sanitizeMailHtml(inline).html).toContain('data:image/png');
        expect(sanitizeMailHtml(inline).blockedImageCount).toBe(0);
    });
});

describe('links', () => {
    it('collects every link with its real target', () => {
        const result = sanitizeMailHtml('<a href="https://echt.example/pfad">Klick hier</a>');

        expect(result.links).toEqual([
            { text: 'Klick hier', href: 'https://echt.example/pfad', misleading: false },
        ]);
    });

    it('flags a link whose text claims a different host than its target', () => {
        // The oldest trick there is, and invisible in a rendered mail.
        const result = sanitizeMailHtml(
            '<a href="https://ganz-woanders.example/x">https://versandhaus.example/angebote</a>'
        );

        expect(result.links[0]?.misleading).toBe(true);
    });

    it('does not cry wolf when the text is ordinary prose', () => {
        const result = sanitizeMailHtml('<a href="https://echt.example">Mehr erfahren</a>');
        expect(result.links[0]?.misleading).toBe(false);
    });

    it('marks links as noopener, in case the markup is ever used outside the sandbox', () => {
        const result = sanitizeMailHtml('<a href="https://x.example">x</a>');
        expect(result.html).toContain('noopener');
    });
});

describe('the frame document', () => {
    it('forbids every outbound request by default', () => {
        const document_ = buildFrameDocument('<p>x</p>', false);

        expect(document_).toContain("default-src 'none'");
        expect(document_).toContain('img-src data:');
        expect(document_).not.toContain('img-src https:');
    });

    it('opens exactly one hole when images are allowed', () => {
        const document_ = buildFrameDocument('<p>x</p>', true);

        expect(document_).toContain('img-src https: data:');
        expect(document_).toContain("default-src 'none'");
        // Nothing else gains a source: no scripts, no fonts, no frames.
        expect(document_).not.toContain('script-src');
    });

    it('blocks form submission and base-tag hijacking regardless', () => {
        const document_ = buildFrameDocument('<p>x</p>', true);

        expect(document_).toContain("form-action 'none'");
        expect(document_).toContain("base-uri 'none'");
    });
});

describe('what survives', () => {
    it('keeps the readable message intact', () => {
        const result = sanitizeMailHtml(
            '<h2>Titel</h2><p><strong>Fett</strong> und <em>kursiv</em></p><table><tr><td>Zelle</td></tr></table>'
        );

        expect(result.html).toContain('<h2>Titel</h2>');
        expect(result.html).toContain('<strong>Fett</strong>');
        expect(result.html).toContain('Zelle');
    });
});
