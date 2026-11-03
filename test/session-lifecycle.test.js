const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const mainPath = path.join(__dirname, '../main.js');
const applicationRequire = createRequire(mainPath);
let folder;
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-lifecycle-')); });
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function appMain(launch, controls = {}) {
    const handlers = new Map(), logs = [], launches = [];
    let win, quitCount = 0;
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const app = Object.assign(new EventEmitter(), {
        getPath: () => folder,
        requestSingleInstanceLock: () => true,
        whenReady: () => ({ then: ready => ready() }),
        quit() {
            const attempt = event();
            app.emit('before-quit', attempt);
            if (!attempt.prevented) quitCount++;
            return attempt;
        }
    });
    class BrowserWindow extends EventEmitter {
        constructor() {
            super();
            win = this;
            this.webContents = { send: (_, text) => logs.push(text) };
        }
        static fromWebContents() { return win; }
        loadFile() {}
        isDestroyed() { return false; }
        close() {
            const attempt = event();
            this.emit('close', attempt);
            if (!attempt.prevented) app.emit('window-all-closed');
            return attempt;
        }
    }
    vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
        require: name => name === 'electron' ? { app, BrowserWindow,
            ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} } }
            : name === 'puppeteer' ? { launch: options => { launches.push(options); return launch(options); } }
                : name === './listing-controls' ? { ...applicationRequire(name), ...controls }
                : applicationRequire(name),
        process, console, setTimeout, Date, Math, AbortController
    });
    return { app, win, logs, launches, handlers, quitCount: () => quitCount,
        start: () => handlers.get('process-drafts')({ sender: {} }, {}) };
}

test('profile-lock errors give recovery instructions without replacing the profile or modifying history', async () => {
    const profile = path.join(folder, 'Gameflip_Ghost_Session');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'profile-marker'), 'keep login');
    const history = JSON.stringify({ version: 1, submissions: [Date.now() - 10000], cooldownUntil: 0 });
    const historyPath = path.join(folder, 'posting-history.json');
    fs.writeFileSync(historyPath, history);
    const main = appMain(() => { throw new Error(`The browser is already running for ${profile}. Use a different userDataDir or stop the running browser first.`); });
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await main.start();
        assert.equal(result.success, false);
        assert.equal(result.postedCount, 0);
        assert.match(result.error, /already open or locked/);
        assert.match(result.error, /Close its Chrome window/);
        assert.match(result.error, /restart Windows/);
        assert.match(result.error, /Keep the Gameflip_Ghost_Session folder/);
    }
    assert.equal(main.launches.length, 2, 'A failed launch must release the run guard for another attempt');
    assert.equal(main.launches[0].userDataDir, main.launches[1].userDataDir);
    assert.equal(fs.readFileSync(path.join(profile, 'profile-marker'), 'utf8'), 'keep login');
    assert.equal(fs.readFileSync(historyPath, 'utf8'), history);
    assert.ok(main.logs.some(text => /paused during "Launching Chrome"/.test(text)));
});

test('other launch errors retain their original diagnosis', async () => {
    const main = appMain(() => { throw new Error('The browser cannot write to the profile directory'); });
    const result = await main.start();
    assert.match(result.error, /cannot write/);
    assert.doesNotMatch(result.error, /already open or locked/);
});

for (const closing of ['window', 'app']) {
    test(`${closing} close during launch waits for owned Chrome cleanup and prevents navigation or posting`, async () => {
        const launched = deferred(), launchResult = deferred(), closingBrowser = deferred(), closeDone = deferred();
        let closeCount = 0;
        const main = appMain(() => { launched.resolve(); return launchResult.promise; });
        const run = main.start();
        await launched.promise;
        const close = () => closing === 'window' ? main.win.close() : main.app.quit();
        assert.equal(close().prevented, true);
        assert.equal(close().prevented, true, 'Repeated close requests must not schedule duplicate cleanup');
        assert.equal(main.quitCount(), 0);
        launchResult.resolve({
            pages() { throw new Error('Must not navigate after close was requested'); },
            async close() { closeCount++; closingBrowser.resolve(); await closeDone.promise; }
        });
        await closingBrowser.promise;
        assert.equal(main.quitCount(), 0, 'Electron must stay alive until browser.close finishes');
        assert.equal((await main.start()).success, false);
        closeDone.resolve();
        const result = await run;
        await Promise.resolve();
        assert.equal(result.success, true);
        assert.equal(result.postedCount, 0);
        assert.equal(closeCount, 1);
        assert.equal(main.quitCount(), 1);
        assert.equal(fs.existsSync(path.join(folder, 'posting-history.json')), false);
        assert.ok(main.logs.some(text => /GHOST SESSION CLOSED/.test(text)));
    });
}

test('closing an idle app does not start Chrome or create posting history', () => {
    const main = appMain(() => { throw new Error('Unexpected Chrome launch'); });
    assert.equal(main.win.close().prevented, false);
    assert.equal(main.quitCount(), 1);
    assert.equal(main.launches.length, 0);
    assert.equal(fs.existsSync(path.join(folder, 'posting-history.json')), false);
});

for (const closing of ['stop', 'quit']) {
    test(`${closing} interrupts the manual-login wait and closes owned Chrome promptly`, async () => {
        const waiting = deferred();
        let closeCount = 0;
        const page = Object.assign(new EventEmitter(), {
            url: () => 'https://gameflip.com/login',
            setDefaultTimeout() {},
            waitForFunction: (_predicate, { signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('Login wait aborted')), { once: true });
                waiting.resolve();
            })
        });
        const browser = Object.assign(new EventEmitter(), { pages: async () => [page], close: async () => { closeCount++; } });
        const main = appMain(async () => browser, { navigate: async () => {} });
        const run = main.start();
        await waiting.promise;
        if (closing === 'quit') assert.equal(main.app.quit().prevented, true);
        else await main.handlers.get('stop-drafts')();
        const result = await run;
        await Promise.resolve();
        assert.equal(result.success, true, result.error);
        assert.equal(result.postedCount, 0);
        assert.equal(closeCount, 1);
        assert.equal(main.quitCount(), closing === 'quit' ? 1 : 0);
        assert.equal(fs.existsSync(path.join(folder, 'posting-history.json')), false);
    });
}
