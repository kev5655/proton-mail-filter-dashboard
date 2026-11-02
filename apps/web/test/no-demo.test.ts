import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The demo mailbox is gone, and this is what keeps it gone.
 *
 * It was not removed for tidiness. The dashboard fell back to it whenever `/api/mailbox` did not
 * answer `200` — which covered **423, the locked vault** — so a running server whose account was
 * simply shut produced a complete, plausible dashboard full of invented folders and rules, with no
 * lock screen, no sign-in button, and nothing on screen that led anywhere. The states that most
 * needed saying out loud were the two the fallback hid.
 *
 * The synthetic mailbox itself still exists, under `test/fixtures/`, because screens have to be
 * rendered against something. The guarantee is its location: a file under `src/` cannot import it
 * without saying `../../test/`, and that is what is checked here.
 *
 * The second check is the one that matters more, because the first can be satisfied while the idea
 * creeps back in: no file under `src/` may branch on *which* mailbox it has. There is one.
 */

const SRC = join(import.meta.dirname, '..', 'src');

function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            return sources(path);
        }
        return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
    });
}

const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('the dashboard has one mailbox', () => {
    it('finds files to check, so an empty sweep cannot pass for a clean one', () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it('imports nothing from the fixtures', () => {
        const offenders = files
            .filter(({ text }) => text.includes('test/fixtures') || text.includes('@pms/demo'))
            .map(({ path }) => path);

        expect(offenders).toEqual([]);
    });

    it('has no source to branch on', () => {
        // `MailboxStatus` carried a `source` field and a dozen screens read it. Reintroducing one
        // is how the demo would come back: not as a package, but as a second thing to render.
        const offenders = files
            .filter(({ text }) => /source === 'demo'|source !== 'demo'|MailboxSource/.test(text))
            .map(({ path }) => path);

        expect(offenders).toEqual([]);
    });
});
