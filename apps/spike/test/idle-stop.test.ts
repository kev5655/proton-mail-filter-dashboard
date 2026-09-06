import { describe, expect, it } from 'vitest';

import { nothingLeftToHold } from '../src/serve-command.js';

/**
 * When the server may end itself, and — the part worth testing — when it must not.
 *
 * `PMS_STOP_WHEN_LOCKED` lets the process exit once it holds nothing, so a machine nobody is sitting
 * at is not running a service for no reason. The way back is the wake screen, which asks a small
 * program on the host to start the container again.
 *
 * That pairing is exactly what makes the obvious rule wrong. „Stop while locked" is true of a
 * *freshly started* server too — it comes up locked by design, because the key is not in it yet — so
 * a server started by the wake screen would end a moment later, and the wake screen would offer to
 * start it again. A loop, and one that would look like a crash to whoever was watching.
 *
 * The three conditions are therefore not decoration, and the first exists for no other reason.
 */

const HOLDING_NOTHING = { everUnlocked: true, uiLocked: true, vaultUnlocked: false };

describe('whether the server still has a reason to run', () => {
    it('ends once it is locked and the key is gone', () => {
        expect(nothingLeftToHold(HOLDING_NOTHING)).toBe(true);
    });

    it('does not end a server nobody has unlocked yet', () => {
        // The loop this whole predicate exists to prevent. A fresh start looks exactly like the
        // case above except for this flag.
        expect(nothingLeftToHold({ ...HOLDING_NOTHING, everUnlocked: false })).toBe(false);
    });

    it('does not end while the key is still held', () => {
        // Inside the grace period: the dashboard shows the lock screen, but the database is open
        // and the Proton session is live. Ending here would throw away exactly the convenience the
        // grace period is.
        expect(nothingLeftToHold({ ...HOLDING_NOTHING, vaultUnlocked: true })).toBe(false);
    });

    it('does not end while somebody is using it', () => {
        expect(nothingLeftToHold({ ...HOLDING_NOTHING, uiLocked: false })).toBe(false);
    });

    it('does not end a server that is open and in use, whatever else is true', () => {
        expect(
            nothingLeftToHold({ everUnlocked: true, uiLocked: false, vaultUnlocked: true })
        ).toBe(false);
    });
});
