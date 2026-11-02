import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The home-screen icons, drawn from the same geometry as `logo.svg`.
 *
 * iOS does not accept an SVG for `apple-touch-icon`, and installing the dashboard on a phone is the
 * whole point of the manifest — so PNGs have to exist. They are generated rather than committed as
 * opaque binaries: an icon nobody can regenerate is an icon that drifts from the mark it came from
 * the first time either is touched.
 *
 * No dependency and no rasteriser, because the mark is four shapes with exact definitions: a
 * rounded rectangle under a linear gradient, three round-capped strokes, and a ring. Each is a
 * distance function, sampled 4×4 per pixel for the edges. That is more faithful than tracing it by
 * hand and it runs anywhere Node does.
 *
 * `pnpm icons` writes them. The manifest and `index.html` reference the results by name.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'apps', 'web', 'public');

/** The geometry of `logo.svg`, in its own 32×32 coordinate system. */
const ART = {
    box: { x: 1.5, y: 1.5, w: 29, h: 29, r: 8 },
    from: [0x8a, 0x6d, 0xff],
    to: [0x6d, 0x4a, 0xff],
    strokes: [
        { x1: 8, y1: 11.5, x2: 24, y2: 11.5 },
        { x1: 8, y1: 16, x2: 19, y2: 16 },
        { x1: 8, y1: 20.5, x2: 14, y2: 20.5 },
    ],
    ring: { cx: 23, cy: 20.5, r: 2.5 },
    strokeWidth: 2,
};

const SAMPLES = 4;

function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
}

/** Signed distance to a rounded rectangle: negative inside. */
function sdRoundedRect(px, py, { x, y, w, h, r }) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const dx = Math.abs(px - cx) - (w / 2 - r);
    const dy = Math.abs(py - cy) - (h / 2 - r);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - r;
}

/** Signed distance to a round-capped segment. */
function sdSegment(px, py, { x1, y1, x2, y2 }) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const wx = px - x1;
    const wy = py - y1;
    const length = vx * vx + vy * vy;
    const t = length === 0 ? 0 : clamp((wx * vx + wy * vy) / length, 0, 1);
    return Math.hypot(wx - vx * t, wy - vy * t);
}

/**
 * The colour and coverage at one point of the artwork.
 *
 * `full` bleeds the background to the edges, which is what a maskable icon needs: the launcher
 * crops it to whatever shape the platform likes, and a rounded corner inside the crop shows as a
 * chipped one.
 */
function sample(px, py, full) {
    const inBox = full ? -1 : sdRoundedRect(px, py, ART.box);
    if (inBox > 0) {
        return undefined;
    }

    const half = ART.strokeWidth / 2;
    const white =
        ART.strokes.some((segment) => sdSegment(px, py, segment) <= half) ||
        Math.abs(Math.hypot(px - ART.ring.cx, py - ART.ring.cy) - ART.ring.r) <= half;

    if (white) {
        return [255, 255, 255];
    }

    // The gradient runs corner to corner, as `x1=0 y1=0 x2=1 y2=1` on the object bounding box.
    const t = clamp(((px - ART.box.x) / ART.box.w + (py - ART.box.y) / ART.box.h) / 2, 0, 1);
    return ART.from.map((channel, index) => Math.round(channel + (ART.to[index] - channel) * t));
}

function render(size, { full = false, padding = 0 } = {}) {
    const pixels = Buffer.alloc(size * size * 4);
    const scale = 32 / (size * (1 - padding * 2));
    const offset = -size * padding;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let hits = 0;

            for (let sy = 0; sy < SAMPLES; sy++) {
                for (let sx = 0; sx < SAMPLES; sx++) {
                    const px = (x + (sx + 0.5) / SAMPLES + offset) * scale;
                    const py = (y + (sy + 0.5) / SAMPLES + offset) * scale;
                    const colour = sample(px, py, full);
                    if (colour !== undefined) {
                        r += colour[0];
                        g += colour[1];
                        b += colour[2];
                        hits++;
                    }
                }
            }

            const total = SAMPLES * SAMPLES;
            const at = (y * size + x) * 4;
            if (hits > 0) {
                pixels[at] = Math.round(r / hits);
                pixels[at + 1] = Math.round(g / hits);
                pixels[at + 2] = Math.round(b / hits);
            }
            // Coverage, so the rounded corner is smooth rather than stepped.
            pixels[at + 3] = Math.round((hits / total) * 255);
        }
    }

    return pixels;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

function png(size, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // truecolour with alpha
    // Filter 0 on every scanline: these are small, and a filter that helps a photograph does
    // nothing for flat colour.
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const WANTED = [
    // What iOS puts on a home screen. It ignores the manifest's icons entirely.
    { name: 'icon-180.png', size: 180 },
    { name: 'icon-192.png', size: 192 },
    { name: 'icon-512.png', size: 512 },
    // Maskable: full bleed, artwork inside the 80% safe zone every launcher agrees on.
    { name: 'icon-maskable-512.png', size: 512, full: true, padding: 0.1 },
];

mkdirSync(OUT, { recursive: true });
for (const { name, size, full = false, padding = 0 } of WANTED) {
    writeFileSync(join(OUT, name), png(size, render(size, { full, padding })));
    console.log(`${name} — ${size}×${size}`);
}
