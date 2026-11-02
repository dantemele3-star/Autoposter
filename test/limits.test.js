const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PostingBudget, POST_INTERVAL_MS, MAX_POST_INTERVAL_MS, DAY_MS, DAILY_LIMIT, CONFIRMATION_TIMEOUT_MS } = require('../posting-budget');
const { ActionPacer, MIN_CLICK_DELAY_MS, MAX_CLICK_DELAY_MS } = require('../pacing');

let folder, file, clock;
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-limits-'));
    file = path.join(folder, 'posting-history.json');
    clock = 1800000000000;
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));
const budget = () => new PostingBudget(file, { now: () => clock, random: () => 0 });

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
    assert.equal(restored.waitMs, MAX_POST_INTERVAL_MS + CONFIRMATION_TIMEOUT_MS - 1000);
    assert.throws(() => budget().reserve(), /interval has not elapsed/);
});

test('completed attempts sample new cooldowns at the minimum, midpoint and maximum', () => {
    const samples = [0, 0.5, 1 - Number.EPSILON];
    const posting = new PostingBudget(file, { now: () => clock, random: () => samples.shift() });
    for (const expected of [220000, 225000, 230000]) {
        posting.reserve();
        clock += 12000;
        posting.finishAttempt();
        assert.equal(posting.status().waitMs, expected);
        assert.ok(expected >= POST_INTERVAL_MS && expected <= MAX_POST_INTERVAL_MS);
        clock += expected;
    }
    assert.equal(samples.length, 0, 'Only finished attempts should sample a cooldown');
});

test('a randomized cooldown survives repeated checks and restart without rerolling its deadline', () => {
    const posting = new PostingBudget(file, { now: () => clock, random: () => 0.5 });
    posting.reserve();
    posting.finishAttempt();
    const saved = fs.readFileSync(file, 'utf8');
    const restored = new PostingBudget(file, { now: () => clock, random: () => { throw new Error('Unexpected reroll'); } });
    assert.equal(restored.status().waitMs, 225000);
    assert.equal(restored.status().waitMs, 225000);
    clock += 224999;
    assert.equal(restored.status().waitMs, 1);
    assert.throws(() => restored.reserve(), /interval has not elapsed/);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    clock++;
    assert.equal(restored.reserve(), 2);
});

test('existing version-one posting history keeps its saved cooldown and submissions', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, submissions: [clock - 10000], cooldownUntil: clock + 1000 }));
    assert.deepEqual(budget().status(), { count: 1, waitMs: 1000 });
    assert.throws(() => budget().reserve(), /interval has not elapsed/);
    clock += 1000;
    assert.equal(budget().reserve(), 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).submissions, [clock - 11000, clock]);
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

test('the action pacer counts existing idle time toward its randomized delay after action completion', async () => {
    const waits = [];
    const pacer = new ActionPacer({ now: () => clock, random: () => 0.5,
        sleep: async ms => { waits.push(ms); clock += ms; } });
    await pacer.wait();
    const first = clock;
    clock += 200; // Time spent dispatching the first click.
    pacer.mark();
    clock += 400;
    await pacer.wait();
    assert.ok(clock - first >= MIN_CLICK_DELAY_MS + 200);
    assert.deepEqual(waits, [3000, 2600]);
    pacer.mark();
    clock += 5000;
    await pacer.wait();
    assert.equal(waits.length, 2);
});

test('the action pacer samples a fresh delay for every action within the two-to-four-second bounds', async () => {
    const samples = [0, 0.5, 1 - Number.EPSILON];
    const waits = [];
    const pacer = new ActionPacer({ now: () => clock, random: () => samples.shift(),
        sleep: async ms => { waits.push(ms); clock += ms; } });
    for (let i = 0; i < 3; i++) {
        await pacer.wait();
        pacer.mark();
    }
    assert.deepEqual(waits, [2000, 3000, 4000]);
    assert.ok(waits.every(ms => ms >= MIN_CLICK_DELAY_MS && ms <= MAX_CLICK_DELAY_MS));
    assert.equal(samples.length, 0);
});
