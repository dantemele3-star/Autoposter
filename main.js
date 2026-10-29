const { app, BrowserWindow, ipcMain } = require('electron');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    listingId, findControl, clickElement, clickControl, navigate, dismissPopup,
    deleteOldestListing, waitForPublished, settle
} = require('./listing-controls');

let shouldStop = false;
let isRunning = false;

async function waitBetweenPosts(ms) {
    const end = Date.now() + ms;
    while (!shouldStop && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
    }
}

function sendLog(win, message) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('log-message', message);
    }
}

async function processDrafts(win, config) {
    const sessionPath = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'Gameflip_Ghost_Session')
        : path.join(app.getPath('userData'), 'Gameflip_Ghost_Session');
    const executablePath = process.env.CHROME_PATH || (process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter(Boolean).map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
            .find(file => fs.existsSync(file))
        : undefined);

    const browser = await puppeteer.launch({
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
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    page.setDefaultTimeout(15000);
    let postedCount = 0;

    try {
        sendLog(win, "\n--- 👻 GHOST SESSION STARTED ---");
        sendLog(win, `Mode: ${config.headless ? 'Headless (Hidden)' : 'Headed (Visible)'}`);
        sendLog(win, "Navigating to Gameflip Drafts...");
        await navigate(page, 'https://gameflip.com/listings/draft');

        if (page.url().includes('login')) {
            sendLog(win, "⚠️ Not logged in. Please log in manually...");
            await page.waitForFunction(() => window.location.href.includes('/listings/draft'), { timeout: 600000 });
            sendLog(win, "✅ Login detected. Continuing...");
            await dismissPopup(page);
        }

        sendLog(win, "Scanning for all drafts across all pages...");
        let allDraftIndices = [];
        let currentPage = 1;
        let hasMorePages = true;

        while (hasMorePages) {
            sendLog(win, `Scanning page ${currentPage}...`);
            if (shouldStop) return { success: true, postedCount };
            await navigate(page, `https://gameflip.com/listings/draft?page=${currentPage}`);

            const pageDrafts = await page.$$('.tool-duplicate');
            sendLog(win, `Found ${pageDrafts.length} drafts on page ${currentPage}.`);

            for (let i = 0; i < pageDrafts.length; i++) {
                allDraftIndices.push({ page: currentPage, index: i });
            }

            const nextExists = await page.evaluate(() => [...document.querySelectorAll('.pagination a, a[rel="next"]')]
                .some(a => !a.closest('.disabled, [aria-disabled="true"]') &&
                    (a.rel === 'next' || /^(next|›|»|>)$/i.test(a.textContent.trim()) ||
                    /next/i.test(a.getAttribute('aria-label') || ''))));

            if (nextExists && pageDrafts.length > 0) {
                sendLog(win, `Moving to page ${currentPage + 1}...`);
                currentPage++;
            } else {
                hasMorePages = false;
                sendLog(win, "No more pages found.");
            }
        }

        if (allDraftIndices.length === 0) {
            throw new Error("No drafts found. Please ensure you are on the Drafts page.");
        }

        sendLog(win, `🎯 Total found: ${allDraftIndices.length} drafts to process.`);

        let processingQueue = [...allDraftIndices];
        if (config.randomize) {
            sendLog(win, "🎲 Randomizing processing order...");
            for (let i = processingQueue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [processingQueue[i], processingQueue[j]] = [processingQueue[j], processingQueue[i]];
            }
        }

        for (let i = 0; i < processingQueue.length; i++) {
            if (shouldStop) {
                sendLog(win, "\n🛑 Stop signal received. Ending session...");
                break;
            }

            const item = processingQueue[i];
            sendLog(win, `\n📦 Processing Item ${i + 1}/${processingQueue.length} (Page ${item.page}, Index ${item.index + 1})...`);

            try {
                await navigate(page, `https://gameflip.com/listings/draft?page=${item.page}`);

                await dismissPopup(page);

                const currentButtons = await page.$$('.tool-duplicate');
                if (currentButtons.length <= item.index) {
                    sendLog(win, " ⚠️ Item no longer at this position on page, skipping.");
                    continue;
                }
                const copyButton = currentButtons[item.index];

                await clickElement(page, copyButton);
                await settle(page);
                await dismissPopup(page);
                await clickControl(page, 'done');
                await settle(page);
                await dismissPopup(page);
                // Wait for the preview before capturing the new copy's ID.
                const listReady = await page.waitForFunction(findControl, {}, 'list');
                await listReady.dispose();
                const draftId = listingId(page.url());
                await clickControl(page, 'list');
                const publishedId = await waitForPublished(page, draftId);

                postedCount++;
                sendLog(win, ` ✨ Item processed successfully.`);

                if (config.maintainLimit) {
                    await deleteOldestListing(page, message => sendLog(win, message), publishedId);
                }

                const minDelay = 220000;
                const randomBuffer = Math.floor(Math.random() * 20000);
                const totalDelay = minDelay + randomBuffer;

                if ((i < processingQueue.length - 1 || config.loop) && !shouldStop) {
                    sendLog(win, `⏳ Rate Limit Protection: Waiting ${Math.round(totalDelay/1000)}s until next post...`);
                    await waitBetweenPosts(totalDelay);
                }

            } catch (itemErr) {
                sendLog(win, ` ❌ Item failed: ${itemErr.message}`);
                throw itemErr;
            }
        }

        sendLog(win, `\n--- 🏁 CYCLE FINISHED ---`);
        sendLog(win, `Total successfully posted in this cycle: ${postedCount}`);
        return { success: true, postedCount };
    } catch (err) {
        sendLog(win, `❌ CRITICAL ERROR: ${err.message}`);
        err.postedCount = postedCount;
        throw err;
    } finally {
        await browser.close();
        sendLog(win, "--- 👻 GHOST SESSION CLOSED ---");
    }
}

ipcMain.handle('process-drafts', async (event, config = {}) => {
    if (isRunning) return { success: false, error: 'Posting is already running.' };
    const win = BrowserWindow.fromWebContents(event.sender);
    isRunning = true;
    shouldStop = false;
    let totalPosted = 0;
    try {
        do {
            const result = await processDrafts(win, config);
            totalPosted += result.postedCount;
            if (!config.loop || shouldStop) break;
            sendLog(win, '♻️ Loop enabled. Restarting in 30 seconds...');
            await waitBetweenPosts(30000);
        } while (!shouldStop);
        return { success: true, postedCount: totalPosted };
    } catch (err) {
        return { success: false, postedCount: totalPosted + (err.postedCount || 0), error: err.message };
    } finally {
        isRunning = false;
    }
});

ipcMain.handle('stop-drafts', async () => {
    console.log("🛑 Stop signal sent from GUI...");
    shouldStop = true;
    return { success: true };
});

app.whenReady().then(() => {
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
