const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PostingBudget, POST_INTERVAL_MS, DAY_MS, DAILY_LIMIT, CONFIRMATION_TIMEOUT_MS } = require('../posting-budget');
const { ActionPacer, MIN_CLICK_DELAY_MS } = require('../pacing');

let folder, file, clock;
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-limits-'));
    file = path.join(folder, 'posting-history.json');
    clock = 1800000000000;
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));
const budget = () => new PostingBudget(file, { now: () => clock });

test('the 220-second cooldown survives restarts and releases at the exact boundary', () => {
    assert.equal(budget().reserve(), 1);
    clock += 12000;
    budget().finishAttempt();
    assert.equal(budget().status().waitMs, POST_INTERVAL_MS);
    clock += POST_INTERVAL_MS - 1;
    assert.throws(() => budget().reserve(), /interval has not elapsed/);
    clock++;
    assert.equal(budget().reserve(), 2);
});

test('an interrupted confirmation retains its submission and conservative cooldown', () => {
    budget().reserve();
    clock += 1000;
    const restored = budget().status();
    assert.equal(restored.count, 1);
    assert.equal(restored.waitMs, POST_INTERVAL_MS + CONFIRMATION_TIMEOUT_MS - 1000);
    assert.throws(() => budget().reserve(), /interval has not elapsed/);
});

test('400 tracked submissions block the next attempt until a rolling-24-hour slot expires', () => {
    const submissions = Array.from({ length: DAILY_LIMIT }, (_, index) => clock - (DAILY_LIMIT - index) * 1000);
    fs.writeFileSync(file, JSON.stringify({ version: 1, submissions, cooldownUntil: 0 }));
    assert.throws(() => budget().status(), /Daily limit reached: 400/);
    assert.throws(() => budget().reserve(), /Daily limit reached: 400/);
    assert.equal(JSON.parse(fs.readFileSync(file)).submissions.length, 400);
    clock += DAY_MS - DAILY_LIMIT * 1000;
    assert.equal(budget().status().count, 399);
    assert.equal(budget().reserve(), 400);
    assert.throws(() => budget().status(), /Daily limit reached/);
});

test('expired submissions are removed when a new attempt is saved', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, submissions: [clock - DAY_MS - 1], cooldownUntil: 0 }));
    assert.equal(budget().reserve(), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).submissions, [clock]);
});

test('an unreadable history never resets the cap or permits a new post', () => {
    fs.writeFileSync(file, 'broken history');
    assert.throws(() => budget().status(), /limits were not reset/);
    assert.throws(() => budget().reserve(), /limits were not reset/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken history');
});

test('the action pacer waits after the previous action completes and counts existing idle time', async () => {
    const waits = [];
    const pacer = new ActionPacer({ now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; } });
    await pacer.wait();
    const first = clock;
    clock += 200; // Time spent dispatching the first click.
    pacer.mark();
    clock += 400;
    await pacer.wait();
    assert.ok(clock - first >= MIN_CLICK_DELAY_MS + 200);
    assert.deepEqual(waits, [2000, 1600]);
    pacer.mark();
    clock += 5000;
    await pacer.wait();
    assert.equal(waits.length, 2);
});
