import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Nothing the browser loads may reach a module that only exists in Node.
 *
 * This is not a style rule. `@pms/core/logger` constructs a pino instance at module scope and hands
 * it `process.stderr`; in a browser that is `ReferenceError: process is not defined` at import
 * time, which happens before React renders and leaves a blank page with the error only in the
 * console. It shipped exactly that way once — a `getLogger` in `packages/llm/src/cloud.ts`, added
 * with the cloud providers — and every end-to-end test failed at once while every unit test stayed
 * green, because unit tests run in Node where `process` exists.
 *
 * So the check walks the actual import graph from the entry point rather than grepping a list of
 * packages somebody has to remember to extend. A new dependency added three packages away is
 * caught by the same test on the day it is added.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const ENTRY = join(HERE, '..', 'src', 'main.tsx');

/** Modules that cannot exist in a browser, by the name they are imported under. */
const NODE_ONLY = ['@pms/core/logger', 'node:fs', 'node:path', 'node:crypto', 'node:os', 'pino'];

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'];

/** `@pms/x` and `@pms/x/y` to the file the workspace resolves them to. */
function workspaceFile(specifier: string): string | undefined {
    const match = /^@pms\/([\w-]+)(\/.*)?$/.exec(specifier);
    if (match === null) {
        return undefined;
    }
    const [, name, sub] = match;
    const manifest = join(REPO, 'packages', name as string, 'package.json');
    if (!existsSync(manifest)) {
        return undefined;
    }
    const exports = (JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: Record<string, string> })
        .exports;
    const target = exports?.[sub === undefined ? '.' : `.${sub}`];
    return target === undefined ? undefined : join(REPO, 'packages', name as string, target);
}

function resolveLocal(from: string, specifier: string): string | undefined {
    const base = join(dirname(from), specifier.replace(/\.js$/, ''));
    for (const extension of EXTENSIONS) {
        const candidate = `${base}${extension}`;
        if (existsSync(candidate) && !candidate.endsWith('/')) {
            return candidate;
        }
    }
    return undefined;
}

function importsOf(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const found: string[] = [];
    // `import ... from 'x'`, `export ... from 'x'` and bare `import 'x'`.
    //
    // `import type` and `export type` are skipped, and only those two: they are erased before the
    // bundler ever sees them, so following them would report an offence for a file the browser
    // never loads. `import { type X }` is *not* skipped — that statement survives.
    const pattern =
        /(?:^|\n)\s*(?:import|export)(?!\s+type\s)[\s\S]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier !== undefined) {
            found.push(specifier);
        }
    }
    return found;
}

describe('what the browser actually loads', () => {
    it('never reaches a module that needs Node', () => {
        const seen = new Set<string>();
        const offences: string[] = [];
        const queue = [ENTRY];

        while (queue.length > 0) {
            const file = queue.pop() as string;
            if (seen.has(file)) {
                continue;
            }
            seen.add(file);

            for (const specifier of importsOf(file)) {
                if (NODE_ONLY.includes(specifier) || specifier.startsWith('node:')) {
                    offences.push(`${file.slice(REPO.length + 1)} imports ${specifier}`);
                    continue;
                }
                const next = specifier.startsWith('.')
                    ? resolveLocal(file, specifier)
                    : workspaceFile(specifier);
                if (next !== undefined) {
                    queue.push(next);
                }
            }
        }

        // The traversal has to have gone somewhere, or an unresolvable entry point would make this
        // test pass by visiting nothing.
        expect(seen.size).toBeGreaterThan(30);
        expect(offences).toEqual([]);
    });
});
