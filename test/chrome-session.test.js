const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchSession, recoverWindowsProfile, windowsProfilePattern } = require('../chrome-session');

let folder, profile;
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-recovery-'));
    profile = path.join(folder, 'Gameflip_Ghost_Session');
    fs.mkdirSync(profile);
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));
const locked = () => new Error('The browser is already running for the saved profile.');

for (const user of ['Dante', 'A B', 'A.[B]+C']) {
    test(`Windows process matching requires the exact profile argument (${user})`, () => {
        const expected = `C:\\Users\\${user}\\AppData\\Local\\Gameflip_Ghost_Session`;
        const matches = new RegExp(windowsProfilePattern(expected), 'i');
        for (const arg of [`--user-data-dir="${expected}"`, `"--user-data-dir=${expected}"`, `--user-data-dir "${expected}"`]) {
            assert.equal(matches.test(`"C:\\Program Files\\Google\\Chrome\\chrome.exe" ${arg} --headless`), true, arg);
        }
        assert.equal(matches.test(`chrome.exe --user-data-dir=${expected} --headless`), !/\s/.test(expected));
        for (const other of [expected + '-other', expected + '\\Default', expected.replace('Gameflip_Ghost_Session', 'Google\\Chrome\\User Data')]) {
            assert.equal(matches.test(`chrome.exe --user-data-dir="${other}"`), false, other);
        }
        assert.equal(matches.test(`chrome.exe --other-flag="${expected}"`), false);
        assert.equal(matches.test(`chrome.exe --other--user-data-dir="${expected}"`), false);
        assert.equal(matches.test(`chrome.exe --user-data-dir="${expected}"suffix`), false);
    });
}

test('a locked profile is recovered once and relaunched with the same profile and mode', async () => {
    const options = { userDataDir: profile, headless: true, args: ['--disable-background-mode'] };
    const launches = [], logs = [];
    const browser = {};
    let recoveries = 0;
    const result = await launchSession({ launch: async received => {
        launches.push(received);
        if (launches.length === 1) throw locked();
        return browser;
    } }, options, { platform: 'win32', log: text => logs.push(text), recover: async received => {
        recoveries++;
        assert.equal(received, profile);
    } });
    assert.equal(result, browser);
    assert.deepEqual(launches, [options, options]);
    assert.equal(recoveries, 1);
    assert.ok(logs.some(text => /Retrying Chrome once/.test(text)));
});

test('unrelated launch errors do not stop processes or alter locks', async () => {
    const error = new Error('Chrome cannot write to the profile directory');
    let recovered = false;
    await assert.rejects(launchSession({ launch: async () => { throw error; } }, { userDataDir: profile }, {
        platform: 'win32', recover: async () => { recovered = true; }
    }), received => received === error);
    assert.equal(recovered, false);
});

test('failed inspection pauses without retrying Chrome', async () => {
    let launches = 0;
    await assert.rejects(launchSession({ launch: async () => { launches++; throw locked(); } }, { userDataDir: profile }, {
        platform: 'win32', recover: async () => { throw new Error('Unable to verify process ownership'); }
    }), /Unable to verify process ownership/);
    assert.equal(launches, 1);
});

test('a second launch failure stops instead of looping recovery', async () => {
    let launches = 0, recoveries = 0;
    await assert.rejects(launchSession({ launch: async () => { launches++; throw locked(); } }, { userDataDir: profile }, {
        platform: 'win32', recover: async () => { recoveries++; }
    }), /could not be recovered automatically/);
    assert.equal(launches, 2);
    assert.equal(recoveries, 1);
});

test('Stop during recovery prevents a relaunch', async () => {
    let stopped = false, launches = 0;
    const result = await launchSession({ launch: async () => { launches++; throw locked(); } }, { userDataDir: profile }, {
        platform: 'win32', stopRequested: () => stopped, recover: async () => { stopped = true; }
    });
    assert.equal(result, null);
    assert.equal(launches, 1);
});

test('verified recovery removes only the stale lock and preserves login and posting history', async () => {
    fs.writeFileSync(path.join(profile, 'lockfile'), 'stale lock');
    fs.writeFileSync(path.join(profile, 'Cookies'), 'keep cookies');
    fs.writeFileSync(path.join(profile, 'Local State'), 'keep state');
    fs.writeFileSync(path.join(folder, 'posting-history.json'), 'keep history');
    const logs = [];
    await recoverWindowsProfile(profile, { log: text => logs.push(text), inspect: async received => {
        assert.equal(received, profile);
        assert.equal(fs.existsSync(path.join(profile, 'lockfile')), true, 'Inspection must precede lock removal');
        return { verified: true, stopped: [123] };
    } });
    assert.equal(fs.existsSync(path.join(profile, 'lockfile')), false);
    assert.equal(fs.readFileSync(path.join(profile, 'Cookies'), 'utf8'), 'keep cookies');
    assert.equal(fs.readFileSync(path.join(profile, 'Local State'), 'utf8'), 'keep state');
    assert.equal(fs.readFileSync(path.join(folder, 'posting-history.json'), 'utf8'), 'keep history');
    assert.ok(logs.some(text => /Stopped 1 Chrome/.test(text)));
});

test('a failed or unverified process inspection leaves the lock intact', async () => {
    fs.writeFileSync(path.join(profile, 'lockfile'), 'keep lock');
    for (const inspect of [async () => { throw new Error('Inspection unavailable'); }, async () => ({ verified: false, stopped: [] })]) {
        await assert.rejects(recoverWindowsProfile(profile, { inspect }));
        assert.equal(fs.readFileSync(path.join(profile, 'lockfile'), 'utf8'), 'keep lock');
    }
});

test('a regular Chrome profile and non-file locks are never removed', async () => {
    const other = path.join(folder, 'User Data');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'lockfile'), 'keep normal Chrome');
    let inspected = false;
    await assert.rejects(recoverWindowsProfile(other, { inspect: async () => { inspected = true; } }), /different Chrome profile/);
    assert.equal(inspected, false);
    fs.mkdirSync(path.join(profile, 'lockfile'));
    await assert.rejects(recoverWindowsProfile(profile, { inspect: async () => ({ verified: true, stopped: [] }) }), /not a regular file/);
    assert.equal(fs.statSync(path.join(profile, 'lockfile')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(other, 'lockfile'), 'utf8'), 'keep normal Chrome');
});
