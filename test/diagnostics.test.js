const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RunLog, safeUrl, redact, MAX_LOG_BYTES } = require('../run-log');

let folder, file, messages;
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-diagnostics-'));
    file = path.join(folder, 'autoposter.log');
    messages = [];
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));
const logger = () => new RunLog(file, message => messages.push(message));

test('logged addresses retain pagination and remove account queries, fragments, and URL credentials', () => {
    const value = safeUrl('https://user:password@gameflip.com/listings/draft?page=2&limit=50&token=private#private-fragment');
    assert.equal(value, 'https://gameflip.com/listings/draft?page=2&limit=50&[hidden]');
    assert.equal(redact(`Opening ${value}`), `Opening ${value}`);
    assert.doesNotMatch(safeUrl('https://gameflip.com/login?page=secret&limit=invalid'), /secret|invalid/);
});

test('both saved and visible diagnostics redact common credential patterns', () => {
    const key = 'AIza' + 'x'.repeat(35);
    logger().write(`Failed https://gameflip.com/login?token=private api_key=private-key api_secret=private-secret access_token=private-token password=private-password Bearer private-bearer ${key}`);
    const saved = fs.readFileSync(file, 'utf8');
    const visible = messages.join('\n');
    for (const content of [saved, visible]) {
        assert.doesNotMatch(content, /private|AIza/);
        assert.match(content, /api_key=\[hidden\]/);
        assert.match(content, /Bearer \[hidden\]/);
    }
});

test('logs survive a new run and rotate without growing an unlimited archive', () => {
    logger().write('First run');
    logger().write('Second run');
    assert.match(fs.readFileSync(file, 'utf8'), /First run[\s\S]+Second run/);
    fs.appendFileSync(file, 'x'.repeat(MAX_LOG_BYTES));
    logger().write('Third run');
    assert.match(fs.readFileSync(`${file}.previous`, 'utf8'), /First run/);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /First run/);
    fs.appendFileSync(file, 'x'.repeat(MAX_LOG_BYTES));
    logger().write('Fourth run');
    assert.match(fs.readFileSync(`${file}.previous`, 'utf8'), /Third run/);
    assert.equal(fs.readdirSync(folder).length, 2);
});

test('an unwritable log warns once and keeps the visible run log available', () => {
    fs.writeFileSync(path.join(folder, 'blocked'), 'file, not directory');
    const log = new RunLog(path.join(folder, 'blocked', 'autoposter.log'), message => messages.push(message));
    log.write('Still visible');
    assert.ok(messages.includes('Still visible'));
    assert.equal(messages.filter(message => message.includes('Could not save')).length, 1);
});

test('navigation diagnostics describe 304 and detach before intentional browser cleanup', async () => {
    const page = new EventEmitter();
    const browser = new EventEmitter();
    const frame = {};
    page.mainFrame = () => frame;
    page.url = () => 'https://gameflip.com/listings/draft?page=2&limit=50&token=private';
    page.isClosed = () => true;
    const request = {
        isNavigationRequest: () => true, frame: () => frame, method: () => 'GET',
        url: page.url, resourceType: () => 'document'
    };
    const log = logger();
    log.attach(page, browser);
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 304, url: page.url });
    page.emit('pageerror', new Error('Test script failure token at https://gameflip.com/api?token=private'));
    await log.report(new Error('Test scan failure'), page, 0);
    assert.match(messages.join('\n'), /HTTP 304 \(Not Modified; checking rendered page\)/);
    assert.match(messages.join('\n'), /Recent browser\/network issue: Page script: Test script failure/);
    assert.doesNotMatch(messages.join('\n'), /private/);
    log.detach();
    const count = messages.length;
    page.emit('close');
    browser.emit('disconnected');
    assert.equal(messages.length, count);
    assert.equal(page.listenerCount('response'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
});
