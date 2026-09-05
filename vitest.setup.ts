import { afterEach } from 'vitest';

/**
 * Let React finish before the room is demolished.
 *
 * After a commit, React does not always run passive effects immediately: it schedules a callback,
 * and that callback's first statement reads `window.event`. When a commit happens outside `act()` —
 * from a resolved promise, a timer, an event handler — the flush is left to that callback. If the
 * test file ends first, Vitest tears the DOM environment down and the callback then runs with no
 * `window` at all: „ReferenceError: window is not defined", raised as an *unhandled* error, so the
 * suite exits non-zero while every test passes.
 *
 * That is what made the failure so hard to place: it was attributed to whichever file happened to
 * be running when the stale callback fired, so it named a different file on almost every run and
 * never appeared when that file was run on its own.
 *
 * Awaiting one macrotask here gives the queued flush its turn while the environment still exists.
 * Registered in a setup file rather than per test, because `sequence.hooks` is „stack" by default:
 * a file's own `afterEach` unmounts first, and this runs afterwards — which is the order that makes
 * it work.
 *
 * It is a teardown guarantee, not a licence: a component that commits outside `act()` is still
 * worth wrapping, because only `act()` makes the effect observable to the assertion that follows.
 */
afterEach(async () => {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
});
