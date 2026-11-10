const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preparation({ open, advance, control = async () => ({ dispose: async () => {} }) }) {
    const output = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../draft-preparation.js'), 'utf8'), {
        module: output, setTimeout, Date,
        require: name => name === './drafts' ? { openDraft: open } : {
            advanceEditor: advance, dismissPopup: async () => {}, waitForControl: control,
            changingContext: error => /Execution context was destroyed/.test(error.message)
        }
    });
    return output.exports;
}
const timeout = () => Object.assign(new Error('Waiting failed: timeout exceeded'), { name: 'TimeoutError' });
const item = { key: 'source-id', page: 3, index: 38 };
const page = kind => ({ isClosed: () => false, evaluate: async () => ({ kind, pathname: '/listings/draft' }) });

test('a preview that appears after the timeout is used without another Copy', async () => {
    let copies = 0;
    const { prepareDraft } = preparation({ open: async () => { copies++; return true; }, advance: async () => { throw timeout(); } });
    const result = await prepareDraft(page('preview'), item);
    assert.equal(result.status, 'ready');
    assert.equal(copies, 1);
});

test('transient preparation failures wait 5 and 10 seconds and stop after three attempts', async () => {
    const waits = [], ids = [];
    const { prepareDraft } = preparation({ open: async (_page, source) => { ids.push(source.key); return true; }, advance: async () => { throw timeout(); } });
    const result = await prepareDraft(page('drafts'), item, { wait: async ms => { waits.push(ms); } });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(waits, [5000, 10000]);
    assert.deepEqual(ids, ['source-id', 'source-id', 'source-id']);
});

for (const late of [false, true]) {
    test(`Stop during the final preview check prevents submission readiness (late=${late})`, async () => {
        let stopped = false;
        const target = page('preview');
        target.evaluate = async () => { stopped = true; return { kind: 'preview' }; };
        const { prepareDraft } = preparation({ open: async () => true, advance: async () => { if (late) throw timeout(); } });
        assert.equal((await prepareDraft(target, item, { stopped: () => stopped })).status, 'stopped');
    });
}

test('Stop interrupts the default recovery backoff before another Copy', { timeout: 2000 }, async () => {
    let copies = 0, stopped = false;
    const { prepareDraft } = preparation({ open: async () => { copies++; return true; }, advance: async () => { throw timeout(); } });
    const result = await prepareDraft(page('drafts'), item, { stopped: () => stopped,
        log: message => { if (message.startsWith('Retrying the same source draft')) setTimeout(() => { stopped = true; }, 10); } });
    assert.equal(result.status, 'stopped');
    assert.equal(copies, 1);
});

for (const message of ['Draft page 3 returned HTTP 403; posting paused.', 'Draft page 3 returned HTTP 429; posting paused.',
    'Multiple draft rows share the same identity.', 'Editor identity changed after Done; posting paused without submitting.']) {
    test(`preparation does not retry a safety failure: ${message}`, async () => {
        let copies = 0;
        const error = new Error(message);
        const { prepareDraft } = preparation({ open: async () => { copies++; throw error; }, advance: async () => {} });
        await assert.rejects(prepareDraft(page('drafts'), item), received => received === error);
        assert.equal(copies, 1);
    });
}

test('a 503 while reopening Drafts can retry without accepting an unscanned source', async () => {
    let calls = 0;
    const target = page('drafts');
    const { prepareDraft } = preparation({ open: async () => {
        if (++calls === 1) throw new Error('Draft page 3 returned HTTP 503; posting paused.');
        target.evaluate = async () => ({ kind: 'preview' });
        return true;
    }, advance: async () => {} });
    assert.equal((await prepareDraft(target, item, { wait: async () => {} })).status, 'ready');
    assert.equal(calls, 2);
});
