const { app, BrowserWindow, ipcMain } = require('electron');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

let shouldStop = false;

function sendLog(win, message) {
    if (win) {
        win.webContents.send('log-message', message);
    }
}

async function deleteOldestListing(win, page) {
    try {
        sendLog(win, "🧹 Maintaining active listing limit... Deleting oldest item...");
        
        // Navigate directly to the On Sale section to avoid sold items
        await page.goto('https://gameflip.com/listings/onsale', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

        // 1. ATTEMPT TO SORT BY OLDEST
        let sorted = false;
        try {
            const sortBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button.dropdown-toggle'));
                return buttons.find(b => b.innerText.toLowerCase().includes('created:'));
            });

            if (sortBtn && (await sortBtn.asElement())) {
                sendLog(win, " ⚙️ Found Sort dropdown, clicking...");
                
                await page.evaluate(el => {
                    el.scrollIntoView({ behavior: 'auto', block: 'center' });
                    el.click();
                }, sortBtn);
                
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

                const oldestOption = await page.evaluateHandle(() => {
                    const menu = document.querySelector('.dropdown-menu');
                    if (!menu) return null;
                    const options = Array.from(menu.querySelectorAll('a, .dropdown-item'));
                    return options.find(opt => opt.innerText.toLowerCase().includes('oldest'));
                });

                if (oldestOption && (await oldestOption.asElement())) {
                    await page.evaluate(el => el.click(), oldestOption);
                    sendLog(win, " ✅ Sorted by oldest.");
                    // Significant human-like pause for the page to actually update its list
                    await new Promise(r => setTimeout(r, 6000 + Math.random() * 4000));
                    sorted = true;
                } else {
                    sendLog(win, " ⚠️ Could not find 'Oldest' option in dropdown.");
                }
            } else {
                sendLog(win, " ⚠️ Could not find the Sort dropdown button.");
            }
        } catch (sortErr) {
            sendLog(win, ` ⚠️ Sorting error: ${sortErr.message}`);
        }

        // 2. FIND THE ITEM
        const listing = await page.evaluateHandle(() => {
            const selectors = ['.listing-item', '.listing-row', '[class*="listing"]', 'tr.listing', '.item-row'];
            for (const selector of selectors) {
                const items = document.querySelectorAll(selector);
                if (items.length > 0) return items[0];
            }
            const allLinks = Array.from(document.querySelectorAll('a'));
            const listingLink = allLinks.find(a => a.href.includes('/listings/') && a.innerText.trim() !== '');
            if (listingLink) return listingLink;
            return null;
        });

        if (!listing || !(await listing.asElement())) {
            sendLog(win, " ⚠️ Could not find any active listings to delete.");
            return;
        }

        if (!sorted) {
            sendLog(win, " ⚠️ Warning: Could not sort, deleting first visible listing on 'On Sale' page instead.");
        }

        // Scroll and click the item with human variance
        await page.evaluate(el => {
            el.scrollIntoView({ behavior: 'auto', block: 'center' });
            el.click();
        }, listing);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));

        // 3. FIND AND ACTIVATE DELETE SEQUENCE
        try {
            const powerBtn = await page.evaluateHandle(() => {
                const spans = Array.from(document.querySelectorAll('span.fa-power-off'));
                if (spans.length > 0) return spans[0];
                return document.querySelector('.fa-power-off');
            });

            if (!powerBtn || !(await powerBtn.asElement())) {
                throw new Error("Could not find the power-off menu button.");
            }

            await page.evaluate(el => {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                el.click();
            }, powerBtn);
            sendLog(win, " 🖱️ Clicked power-off menu...");
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

            const trashBtn = await page.evaluateHandle(() => {
                const spans = Array.from(document.querySelectorAll('span.fa-trash'));
                if (spans.length > 0) return spans[0];
                return document.querySelector('.fa-trash');
            });

            if (!trashBtn || !(await trashBtn.asElement())) {
                throw new Error("Could not find the trash icon in the menu.");
            }

            await page.evaluate(el => {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                el.click();
            }, trashBtn);
            sendLog(win, " 🖱️ Clicked trash icon...");
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

            const confirmBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button.btn-primary'));
                return buttons.find(b => b.innerText.toLowerCase().includes('delete'));
            });

            if (!confirmBtn || !(await confirmBtn.asElement())) {
                throw new Error("Could not find the final Delete confirmation button.");
            }

            await page.evaluate(el => {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                el.click();
            }, confirmBtn);
            sendLog(win, " ✅ Oldest listing deleted successfully.");

        } catch (delErr) {
            sendLog(win, ` ⚠️ Delete sequence failed: ${delErr.message}`);
        }
    } catch (e) {
        sendLog(win, ` ❌ Error deleting oldest listing: ${e.message}`);
    }
}

async function processDrafts(win, config) {
    const sessionPath = path.join(os.homedir(), 'AppData', 'Local', 'Gameflip_Ghost_Session');
    
    const browser = await puppeteer.launch({ 
        headless: config.headless,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 
        userDataDir: sessionPath, 
        protocolTimeout: 120000,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ] 
    });
    
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    async function handlePopups(page) {
        try {
            const popupButton = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(b => 
                    (b.innerText.toLowerCase().includes('not now') || b.innerText.toLowerCase().includes('maybe later')) && 
                    (b.getAttribute('data-bs-dismiss') === 'modal' || b.getAttribute('data-dismiss') === 'modal' || b.closest('.modal'))
                );
            });

            if (popupButton && (await popupButton.asElement())) {
                sendLog(win, " 🛡️ Popup detected! Clicking dismiss...");
                await page.evaluate(el => el.click(), popupButton);
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
            }
        } catch (e) {}
    }

    try {
        sendLog(win, "\n--- 👻 GHOST SESSION STARTED ---");
        sendLog(win, `Mode: ${config.headless ? 'Headless (Hidden)' : 'Headed (Visible)'}`);
        sendLog(win, "Navigating to Gameflip Drafts...");
        await page.goto('https://gameflip.com/listings/draft', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

        if (page.url().includes('login')) {
            sendLog(win, "⚠️ Not logged in. Please log in manually...");
            await page.waitForFunction(() => window.location.href.includes('/listings/draft'), { timeout: 600000 });
            sendLog(win, "✅ Login detected. Continuing...");
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        }

        sendLog(win, "Scanning for all drafts across all pages...");
        let allDraftIndices = [];
        let currentPage = 1;
        let hasMorePages = true;

        while (hasMorePages) {
            sendLog(win, `Scanning page ${currentPage}...`);
            await page.goto(`https://gameflip.com/listings/draft?page=${currentPage}`, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

            const pageDrafts = await page.$$('.tool-duplicate');
            sendLog(win, `Found ${pageDrafts.length} drafts on page ${currentPage}.`);
            
            for (let i = 0; i < pageDrafts.length; i++) {
                allDraftIndices.push({ page: currentPage, index: i });
            }

            const nextExists = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                return links.some(a => 
                    a.innerText.trim().toLowerCase().includes('next') || 
                    a.getAttribute('aria-label')?.toLowerCase().includes('next') ||
                    a.innerHTML.includes('next') ||
                    (a.innerText === '>' && a.closest('.pagination'))
                );
            });

            if (nextExists && pageDrafts.length > 0) {
                sendLog(win, `Moving to page ${currentPage + 1}...`);
                currentPage++;
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
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

        let postedCount = 0;

        for (let i = 0; i < processingQueue.length; i++) {
            if (shouldStop) {
                sendLog(win, "\n🛑 Stop signal received. Ending session...");
                break;
            }

            const item = processingQueue[i];
            sendLog(win, `\n📦 Processing Item ${i + 1}/${processingQueue.length} (Page ${item.page}, Index ${item.index + 1})...`);
            
            try {
                await page.goto(`https://gameflip.com/listings/draft?page=${item.page}`, { waitUntil: 'networkidle2' });
                await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
                
                await handlePopups(page);

                const currentButtons = await page.$$('.tool-duplicate');
                if (currentButtons.length <= item.index) {
                    sendLog(win, " ⚠️ Item no longer at this position on page, skipping.");
                    continue;
                }
                const copyButton = currentButtons[item.index];

                await page.evaluate(el => {
                    el.scrollIntoView({ behavior: 'auto', block: 'center' });
                    el.click();
                }, copyButton);
                sendLog(win, " 🖱️ Clicked 'Create a copy in Draft'...");

                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                } catch (e) {
                    sendLog(win, " ⚠️ Navigation timeout, but attempting to continue...");
                }
                await new Promise(r => setTimeout(r, 6000 + Math.random() * 4000));

                await handlePopups(page);

                sendLog(win, "Searching for 'Done' button...");
                let finalDoneBtn = null;
                
                finalDoneBtn = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const btn = buttons.find(b => b.innerText.toLowerCase().includes('done'));
                    if (btn) btn.scrollIntoView({ behavior: 'auto', block: 'center' });
                    return btn;
                });

                if (!finalDoneBtn || !(await finalDoneBtn.asElement())) {
                    sendLog(win, "Done button not visible, attempting gradual search...");
                    const found = await page.evaluate(async () => {
                        for (let i = 0; i < 15; i++) {
                            window.scrollBy(0, 600);
                            await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
                            const buttons = Array.from(document.querySelectorAll('button'));
                            const btn = buttons.find(b => b.innerText.toLowerCase().includes('done'));
                            if (btn) {
                                btn.scrollIntoView({ behavior: 'auto', block: 'center' });
                                return true;
                            }
                        }
                        return false;
                    });

                    if (found) {
                        finalDoneBtn = await page.evaluateHandle(() => {
                            const buttons = Array.from(document.querySelectorAll('button'));
                            return buttons.find(b => b.innerText.toLowerCase().includes('done'));
                        });
                    }
                }

                if (!finalDoneBtn || !(await finalDoneBtn.asElement())) {
                    throw new Error("Could not find 'Done' button after multiple scroll attempts.");
                }
                
                await page.evaluate(el => el.click(), finalDoneBtn);
                sendLog(win, " 🖱️ Clicked 'Done'...");

                await new Promise(r => setTimeout(r, 5000 + Math.random() * 3000));

                await handlePopups(page);

                sendLog(win, "Searching for 'List Item' button...");
                let listBtn = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const btn = buttons.find(b => b.innerText.toLowerCase().includes('list item'));
                    if (btn) btn.scrollIntoView({ behavior: 'auto', block: 'center' });
                    return btn;
                });

                if (!listBtn || !(await listBtn.asElement())) {
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
                    listBtn = await page.evaluateHandle(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const btn = buttons.find(b => b.innerText.toLowerCase().includes('list item'));
                        if (btn) btn.scrollIntoView({ behavior: 'auto', block: 'center' });
                        return btn;
                    });
                }

                if (!listBtn || !(await listBtn.asElement())) {
                    throw new Error("Could not find 'List Item' button.");
                }
                
                await page.evaluate(el => el.click(), listBtn);
                sendLog(win, " ✅ Clicked 'List Item' - SUCCESS!");

                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
                } catch (navErr) {
                    sendLog(win, " ⚠️ Navigation timeout on final step, continuing...");
                }
                
                postedCount++;
                sendLog(win, ` ✨ Item processed successfully.`);

                if (config.maintainLimit) {
                    await deleteOldestListing(win, page);
                }

                const minDelay = 220000; 
                const randomBuffer = Math.floor(Math.random() * 20000);
                const totalDelay = minDelay + randomBuffer;
                
                sendLog(win, `⏳ Rate Limit Protection: Waiting ${Math.round(totalDelay/1000)}s until next post...`);
                await new Promise(r => setTimeout(r, totalDelay));

            } catch (itemErr) {
                sendLog(win, ` ❌ Item failed: ${itemErr.message}`);
            }
        }

        sendLog(win, `\n--- 🏁 CYCLE FINISHED ---`);
        sendLog(win, `Total successfully posted in this cycle: ${postedCount}`);
        return { success: true, postedCount };
    } catch (err) {
        sendLog(win, `❌ CRITICAL ERROR: ${err.message}`);
        throw new Error(`Draft-Poster Error: ${err.message}`);
    } finally {
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 2000));
        await browser.close();
        sendLog(win, "--- 👻 GHOST SESSION CLOSED ---");
    }
}

ipcMain.handle('process-drafts', async (event, config) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    shouldStop = false; 
    
    let totalPosted = 0;
    let cycle = 1;

    while (true) {
        sendLog(win, `\n🚀 Starting Cycle ${cycle}...`);
        try {
            const result = await processDrafts(win, config);
            totalPosted += result.postedCount;
            cycle++;
            
            if (!config.loop || shouldStop) {
                break;
            }
            sendLog(win, `\n♻️ Loop enabled. Restarting in 30 seconds...`);
            await new Promise(r => setTimeout(r, 30000));
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    return { success: true, postedCount: totalPosted };
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
