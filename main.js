const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    clickControl, waitForControl, navigate, dismissPopup,
    deleteOldestListing, capturePublication, waitForPublished
} = require('./listing-controls');
const { scanDrafts, openDraft } = require('./drafts');
const { PostingBudget, DAILY_LIMIT } = require('./posting-budget');
const { RunLog, redact } = require('./run-log');
const { version } = require('./package.json');

let shouldStop = false;
let isRunning = false;

async function waitBetweenPosts(ms) {
    const end = Date.now() + ms;
    while (!shouldStop && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
    }
}

async function waitForPostingSlot(run, budget) {
    run.step('Checking the saved posting limits');
    const { waitMs } = budget.status();
    if (waitMs > 0 && !shouldStop) {
        run.step('Waiting for the posting interval');
        run.write(`⏳ Rate Limit Protection: ${Math.ceil(waitMs / 1000)}s remain in the 220-second minimum posting interval...`);
        await waitBetweenPosts(waitMs);
    }
    return !shouldStop;
}

function sendLog(win, message) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('log-message', message);
    }
}

async function processDrafts(run, config, budget) {
    if (!await waitForPostingSlot(run, budget)) return { success: true, postedCount: 0 };
    const log = message => run.write(message);
    const sessionPath = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'Gameflip_Ghost_Session')
        : path.join(app.getPath('userData'), 'Gameflip_Ghost_Session');
    const executablePath = process.env.CHROME_PATH || (process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter(Boolean).map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
            .find(file => fs.existsSync(file))
        : undefined);

    let browser, page;
    let postedCount = 0;
    try {
        run.step('Launching Chrome');
        browser = await puppeteer.launch({
            headless: config.headless,
            defaultViewport: null,
            executablePath,
            userDataDir: sessionPath,
            protocolTimeout: 120000,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--start-maximized',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });

        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();
        run.attach(page, browser);

        page.setDefaultTimeout(30000);

        log("\n--- 👻 GHOST SESSION STARTED ---");
        log(`Mode: ${config.headless ? 'Headless (Hidden)' : 'Headed (Visible)'}`);
        log(`Tracked app submissions in the last 24 hours: ${budget.status().count}/${DAILY_LIMIT}. Browser actions are spaced by at least 2 seconds.`);
        run.step('Navigating to Gameflip Drafts');
        await navigate(page, 'https://gameflip.com/listings/draft', { waitForIdle: false });

        if (page.url().includes('login')) {
            run.step('Waiting for manual Gameflip login');
            await page.waitForFunction(() => window.location.href.includes('/listings/draft'), { timeout: 600000 });
            log("✅ Login detected. Continuing...");
            await dismissPopup(page);
        }

        run.step('Scanning all draft pages');
        const processingQueue = await scanDrafts(page, log, () => shouldStop);
        if (shouldStop) return { success: true, postedCount };

        if (processingQueue.length === 0) {
            throw new Error("No drafts found. Please ensure you are on the Drafts page.");
        }

        log(`🎯 Total found: ${processingQueue.length} drafts to process.`);

        if (config.randomize) {
            log("🎲 Randomizing processing order...");
            for (let i = processingQueue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [processingQueue[i], processingQueue[j]] = [processingQueue[j], processingQueue[i]];
            }
        }

        for (let i = 0; i < processingQueue.length; i++) {
            if (shouldStop) {
                log("\n🛑 Stop signal received. Ending session...");
                break;
            }

            if (!await waitForPostingSlot(run, budget)) break;
            const item = processingQueue[i];
            log(`\n📦 Processing Item ${i + 1}/${processingQueue.length} (Scanned page ${item.page}, row ${item.index + 1})...`);
            log(`Source draft: ${item.key}`);

            run.step('Opening the selected draft copy');
            if (!await openDraft(page, item, log, () => shouldStop)) break;
            await dismissPopup(page);
            run.step('Waiting for Done in the draft editor');
            await clickControl(page, 'done');
            await dismissPopup(page);
            // Wait for the preview before capturing the new copy's ID.
            run.step('Waiting for List Item in the listing preview');
            const listReady = await waitForControl(page, 'list');
            await listReady.dispose();
            let publication;
            let recorded = false;
            try {
                run.step('Submitting the listing (confirmation can take up to 90 seconds)');
                await clickControl(page, 'list', { beforeClick: async () => {
                    publication = await capturePublication(page);
                    const count = budget.reserve();
                    recorded = true;
                    log(`Submission recorded: ${count}/${DAILY_LIMIT} in the last 24 hours.`);
                } });
                log(`Submitted listing ID: ${publication.id || 'not available in the preview'}`);
                run.step('Confirming publication in On Sale');
                const publishedId = await waitForPublished(page, publication, { log });
                postedCount++;
                log('✅ Publication confirmed.');
                if (config.maintainLimit) {
                    if (!publishedId) throw new Error('Publication succeeded, but its ID could not be identified. Count maintenance paused; nothing was deleted.');
                    run.step('Deleting and verifying the oldest listing');
                    await deleteOldestListing(page, log, publishedId);
                }
            } finally {
                if (recorded) budget.finishAttempt();
            }

            if ((i < processingQueue.length - 1 || config.loop) && !shouldStop) {
                await waitForPostingSlot(run, budget);
            }

        }

        log(`\n--- 🏁 CYCLE FINISHED ---`);
        log(`Total successfully posted in this cycle: ${postedCount}`);
        return { success: true, postedCount };
    } catch (err) {
        await run.report(err, page, postedCount);
        err.postedCount = postedCount;
        throw err;
    } finally {
        run.detach();
        if (browser) {
            log('Closing Chrome for this session...');
            try {
                await browser.close();
                log("--- 👻 GHOST SESSION CLOSED ---");
            }
            catch (error) { log(`⚠️ Chrome cleanup: ${error.message}`); }
        }
    }
}

ipcMain.handle('process-drafts', async (event, config = {}) => {
    if (isRunning) return { success: false, error: 'Posting is already running.' };
    const win = BrowserWindow.fromWebContents(event.sender);
    isRunning = true;
    shouldStop = false;
    let totalPosted = 0;
    const run = new RunLog(path.join(app.getPath('userData'), 'autoposter.log'), message => sendLog(win, message));
    try {
        run.write(`Autoposter v${version}; Node ${process.versions.node}; ${process.platform}.`);
        run.write(`Settings: ${JSON.stringify({ headless: !!config.headless, randomize: !!config.randomize, loop: !!config.loop, maintainLimit: !!config.maintainLimit })}`);
        run.write(`Diagnostic log: ${run.file}`);
        const budget = new PostingBudget(path.join(app.getPath('userData'), 'posting-history.json'), { now: () => Date.now() });
        do {
            const result = await processDrafts(run, config, budget);
            totalPosted += result.postedCount;
            if (!config.loop || shouldStop) break;
            run.step('Waiting to restart the next cycle');
            run.write('♻️ Loop enabled. Restarting in 30 seconds...');
            await waitBetweenPosts(30000);
        } while (!shouldStop);
        return { success: true, postedCount: totalPosted };
    } catch (err) {
        if (run.reportedError !== err) await run.report(err, null, totalPosted);
        return { success: false, postedCount: totalPosted + (err.postedCount || 0), error: redact(err.message) };
    } finally {
        isRunning = false;
    }
});

ipcMain.handle('stop-drafts', async () => {
    console.log("🛑 Stop signal sent from GUI...");
    shouldStop = true;
    return { success: true };
});

ipcMain.handle('copy-logs', async (_event, text) => {
    try {
        if (typeof text !== 'string' || !text.trim()) throw new Error('There are no logs to copy.');
        await clipboard.writeText(text);
        // Some Windows clipboard failures do not throw. Verify the write before
        // telling the renderer that copying succeeded (Windows may use CRLF).
        const copied = await clipboard.readText();
        if (copied.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
            throw new Error('The clipboard did not retain the copied logs.');
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: redact(error.message) };
    }
});

ipcMain.handle('open-logs', async () => {
    try {
        const folder = app.getPath('userData');
        const file = path.join(folder, 'autoposter.log');
        fs.mkdirSync(folder, { recursive: true });
        if (fs.existsSync(file)) {
            shell.showItemInFolder(file);
            return { success: true };
        }
        const error = await shell.openPath(folder);
        return { success: !error, error };
    } catch (error) { return { success: false, error: redact(error.message) }; }
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 900,
        height: 800,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    win.loadFile('index.html');
});

for (const [channel, action] of Object.entries({
    'window-minimize': win => win.minimize(),
    'window-maximize': win => win.isMaximized() ? win.unmaximize() : win.maximize(),
    'window-close': win => win.close()
})) {
    ipcMain.on(channel, event => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) action(win);
    });
}
