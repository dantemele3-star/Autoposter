const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { launchSession } = require('../chrome-session');

test('a real locked profile is relaunched with its cookies while an unrelated Chrome stays open', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-browser-recovery-'));
    const profile = path.join(folder, 'Gameflip_Ghost_Session');
    const options = { headless: true, executablePath: process.env.CHROME_PATH || undefined,
        args: [...(process.env.CI ? ['--no-sandbox'] : []), '--disable-background-mode'], userDataDir: profile };
    let original, other, recovered;
    try {
        original = await puppeteer.launch(options);
        other = await puppeteer.launch({ ...options, userDataDir: path.join(folder, 'RegularChrome') });
        await original.setCookie({ name: 'saved-login-marker', value: 'keep', domain: 'fixture.example.test', path: '/',
            expires: Math.floor(Date.now() / 1000) + 3600 });
        let recoveries = 0;
        recovered = await launchSession(puppeteer, options, { platform: 'win32', recover: async received => {
            assert.equal(received, profile);
            recoveries++;
            // Substitute only the OS-specific process-stop operation. The
            // initial profile-lock failure and subsequent relaunch are real.
            await original.close();
        } });
        assert.equal(recoveries, 1, 'The test must encounter an actual profile lock');
        assert.ok((await recovered.cookies()).some(cookie => cookie.name === 'saved-login-marker' && cookie.value === 'keep'));
        assert.equal(other.connected, true);
        assert.ok((await other.pages()).length > 0);
    } finally {
        await Promise.allSettled([recovered?.close(), original?.close(), other?.close()]);
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
