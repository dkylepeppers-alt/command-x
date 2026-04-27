import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function makeSwipeTracker() {
    const pending = new Set();
    const normalize = (mesId) => {
        if (mesId == null || mesId === '') return null;
        const id = Number(mesId);
        return Number.isInteger(id) && id >= 0 ? id : null;
    };
    return {
        mark(mesId) {
            const id = normalize(mesId);
            if (id != null) pending.add(id);
        },
        consume(mesId) {
            const id = normalize(mesId);
            if (id == null || !pending.has(id)) return false;
            pending.delete(id);
            return true;
        },
        clearId(mesId) {
            const id = normalize(mesId);
            if (id != null) pending.delete(id);
        },
        clear() {
            pending.clear();
        },
        size() {
            return pending.size;
        },
    };
}

function makeSwipeRuntime() {
    const tracker = makeSwipeTracker();
    let throttleCount = 0;
    return {
        messageSwiped(mesId) {
            tracker.mark(mesId);
        },
        messageReceived(mesId) {
            const isSwipeRegeneration = tracker.consume(mesId);
            if (!isSwipeRegeneration) throttleCount += 1;
        },
        messageDeleted(mesId) {
            tracker.clearId(mesId);
        },
        chatChanged() {
            tracker.clear();
        },
        throttleCount() {
            return throttleCount;
        },
    };
}

describe('swipe regeneration tracker', () => {
    it('treats a marked message id as exactly one regeneration', () => {
        const tracker = makeSwipeTracker();
        tracker.mark(4);

        assert.equal(tracker.consume(4), true);
        assert.equal(tracker.consume(4), false);
        assert.equal(tracker.size(), 0);
    });

    it('ignores invalid ids and keeps unrelated ids pending', () => {
        const tracker = makeSwipeTracker();

        tracker.mark(null);
        tracker.mark('');
        tracker.mark(-1);
        tracker.mark(1.5);
        tracker.mark('7');
        tracker.mark('007');
        tracker.mark('7.0');

        assert.equal(tracker.consume('bad'), false);
        assert.equal(tracker.consume(8), false);
        assert.equal(tracker.consume(7), true);
        assert.equal(tracker.size(), 0);
    });

    it('can clear pending regenerations on chat changes', () => {
        const tracker = makeSwipeTracker();
        tracker.mark(1);
        tracker.mark(2);

        tracker.clear();

        assert.equal(tracker.consume(1), false);
        assert.equal(tracker.consume(2), false);
        assert.equal(tracker.size(), 0);
    });
});

describe('swipe regeneration handler flow', () => {
    it('marks MESSAGE_SWIPED and skips throttling for the next matching MESSAGE_RECEIVED', () => {
        const runtime = makeSwipeRuntime();

        runtime.messageReceived(2);
        runtime.messageSwiped(2);
        runtime.messageReceived(2);
        runtime.messageReceived(2);

        assert.equal(runtime.throttleCount(), 2);
    });

    it('does not skip throttling when a different message id is received next', () => {
        const runtime = makeSwipeRuntime();

        runtime.messageSwiped(2);
        runtime.messageReceived(3);
        runtime.messageReceived(2);
        runtime.messageReceived(2);

        assert.equal(runtime.throttleCount(), 2);
    });

    it('message deletion clears the pending regeneration marker', () => {
        const runtime = makeSwipeRuntime();

        runtime.messageSwiped(5);
        runtime.messageDeleted(5);
        runtime.messageReceived(5);

        assert.equal(runtime.throttleCount(), 1);
    });

    it('chat changes clear pending regeneration markers', () => {
        const runtime = makeSwipeRuntime();

        runtime.messageSwiped(8);
        runtime.chatChanged();
        runtime.messageReceived(8);

        assert.equal(runtime.throttleCount(), 1);
    });
});

describe('index.js source shape', () => {
    it('marks MESSAGE_SWIPED ids and skips turn throttling for the regenerated response', async () => {
        const src = await readFile(resolve(here, '..', 'index.js'), 'utf8');

        assert.match(src, /const\s+_pendingSwipeRegenerations\s*=\s*new\s+Set\(\)\s*;?/);
        assert.match(src, /function\s+markPendingSwipeRegeneration\s*\(\s*mesId\s*\)/);
        assert.match(src, /function\s+consumePendingSwipeRegeneration\s*\(\s*mesId\s*\)/);
        assert.match(src, /function\s+clearPendingSwipeRegeneration\s*\(\s*mesId\s*\)/);
        assert.match(src, /const\s+isSwipeRegeneration\s*=\s*consumePendingSwipeRegeneration\s*\(\s*mesId\s*\)\s*;?/);
        assert.match(src, /if\s*\(\s*!isSwipeRegeneration\s*\)\s*\{\s*applyInjectionThrottle\s*\(\s*\)\s*;?\s*\}/);
        assert.match(src, /messageSwiped\s*:\s*\(\s*mesId\s*\)\s*=>\s*\{[\s\S]*?markPendingSwipeRegeneration\s*\(\s*mesId\s*\)\s*;?[\s\S]*?removeMessagesForMesId\s*\(\s*mesId\s*\)\s*;?/);
        assert.match(src, /messageDeleted\s*:\s*\(\s*deletedMesId\s*\)\s*=>\s*\{[\s\S]*?clearPendingSwipeRegeneration\s*\(\s*deletedId\s*\)\s*;?/);
        assert.match(src, /chatChangedPhone\s*:\s*\(\s*\)\s*=>\s*\{[\s\S]*?_pendingSwipeRegenerations\.clear\s*\(\s*\)\s*;?/);
    });
});
