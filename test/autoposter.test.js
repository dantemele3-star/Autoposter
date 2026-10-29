const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const controls = require('../listing-controls');

const OLD = '11111111-1111-4111-8111-111111111111';
const RECENT = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';
const NEXT = '44444444-4444-4444-8444-444444444444';
const itemUrl = id => `https://gameflip.com/item/example/${id}`;
let browser, page, state;

before(async () => {
    browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: process.env.CI ? ['--no-sandbox'] : []
    });
});
after(async () => browser?.close());
beforeEach(async () => {
    state = { listings: [RECENT, OLD], visits: [], deleted: [], posts: 0, drafts: 1 };
    page = await browser.newPage();
    const setTimeout = page.setDefaultTimeout.bind(page);
    page.setDefaultTimeout = ms => setTimeout(Math.min(ms, 1500));
    page.setDefaultTimeout(1500);
    await page.setRequestInterception(true);
    page.on('request', async request => {
        const url = new URL(request.url());
        state.visits.push(url.pathname);
        let body;
        if (url.pathname === '/fixture/sorted') {
            await new Promise(resolve => global.setTimeout(resolve, 80));
            body = JSON.stringify([...state.listings].sort());
        } else if (url.pathname === '/fixture/publish') {
            if (!state.rejectPost) {
                state.posts++;
                state.listings.unshift(url.searchParams.get('id'));
            }
            body = '{}';
        } else if (url.pathname === '/fixture/delete') {
            const id = url.searchParams.get('id');
            state.deleted.push(id);
            if (!state.rejectDelete) state.listings = state.listings.filter(value => value !== id);
            body = '{}';
        } else {
            body = fixture(url);
        }
        await request.respond({ status: 200, contentType: url.pathname.startsWith('/fixture/') ? 'application/json' : 'text/html', body });
    });
});
afterEach(async () => page?.close());

// Every browser request is intercepted. No account, cookie or Gameflip network
// access is used; these fixtures reproduce the competing navigation/dropdowns.
function fixture(url) {
    const id = controls.listingId(url.href);
    let content = '';
    if (url.pathname === '/listings/draft') {
        content = [NEW, NEXT].slice(0, state.drafts).map(id =>
            `<a class="tool-duplicate" target="_blank" href="/listings/${id}/edit">Create a copy in Draft</a>`).join('');
        content += '<ul class="pagination"><li class="disabled"><a aria-label="Next" href="?page=2">Next</a></li></ul>';
    } else if (url.pathname.endsWith('/edit')) {
        content = `<button onclick="location.href='/listings/${id}/preview'">Done</button>`;
    } else if (url.pathname.endsWith('/preview')) {
        content = `<button onclick="fetch('/fixture/publish?id=${id}').then(() => {
            ${state.rejectPost ? "document.querySelector('#error').textContent='Post rejected'" : `location.href='/item/example/${id}'`}
        })">List Item</button><div id="error" role="alert"></div>`;
    } else if (url.pathname === '/listings/onsale') {
        content = `<div class="dropdown" id="sort">
            <button class="dropdown-toggle" onclick="this.parentElement.classList.toggle('open')">Created: Newest</button>
            <div class="dropdown-menu">${state.sortBroken ? '' : `<button onclick="sortOldest()">Oldest</button>`}</div>
        </div><div id="rows">${links(state.listings)}</div>
        <script>
            async function sortOldest() {
                document.querySelector('#sort button').textContent = 'Created: Oldest';
                document.querySelector('#sort').classList.remove('open');
                const ids = await fetch('/fixture/sorted').then(r => r.json());
                document.querySelector('#rows').innerHTML = ids.map(id =>
                    '<a href="/item/example/' + id + '">Listing ' + id + '</a>').join('');
            }
        </script>`;
    } else if (id) {
        content = `<div class="dropdown" id="actions">
            <button onclick="this.parentElement.classList.toggle('open')"><span class="fa-power-off">Power</span></button>
            <div class="dropdown-menu"><button onclick="document.querySelector('.modal').style.display='block'">
                <span class="fa-trash">Delete listing</span></button></div>
        </div><div class="modal" role="dialog" style="display:none">
            <button class="btn-primary" onclick="fetch('/fixture/delete?id=${id}').then(() => location.href='/listings/onsale')">Delete</button>
        </div>`;
    }
    return `<!doctype html><style>
        body {min-height:600px} .dropdown-menu{display:none}.open>.dropdown-menu{display:block}
        #profile{position:fixed;right:0;top:0}#profile:hover>.dropdown-menu{display:block}
        a,button{display:block;margin:10px}.modal{position:fixed;inset:100px;background:white}
    </style><header><div class="dropdown" id="profile"><button>Profile</button>
        <div class="dropdown-menu"><a href="/listings/sold">Sold</a><a href="/listings/draft">Drafts</a>
            <button><span class="fa-power-off">Log out</span></button><button><span class="fa-trash">Wrong delete</span></button>
        </div></div></header><nav><a href="/listings/draft">Drafts</a><a href="/listings/sold">Sold</a></nav>
        <div class="listings-container">${content}</div>`;
}
function links(ids) {
    return ids.map(id => `<a target="_blank" href="${itemUrl(id)}">Listing ${id}</a>`).join('');
}

function mainProcess() {
    const handlers = new Map();
    const logs = [];
    const win = { isDestroyed: () => false, webContents: { send: (_, message) => logs.push(message) } };
    let closed = false;
    const fakeBrowser = { pages: async () => [page], close: async () => { closed = true; } };
    const electron = {
        app: { getPath: () => '/tmp/autoposter-test', whenReady: () => ({ then() {} }) },
        BrowserWindow: { fromWebContents: () => win },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), {
        require: name => name === 'electron' ? electron : name === 'puppeteer'
            ? { launch: async () => fakeBrowser } : name === './listing-controls' ? controls : require(name),
        process, console, setTimeout: global.setTimeout
    });
    return { handlers, logs, closed: () => closed };
}

test('oldest deletion ignores navigation/profile menus and waits for sorted rows', async () => {
    state.listings.unshift(NEW);
    await controls.navigate(page, 'https://gameflip.com/listings/onsale');
    await page.hover('#profile');
    const tabs = (await browser.pages()).length;
    const logs = [];
    await controls.deleteOldestListing(page, message => logs.push(message), NEW);
    assert.deepEqual(state.deleted, [OLD]);
    assert.deepEqual(state.listings, [NEW, RECENT]);
    assert.equal(state.visits.includes('/listings/sold'), false);
    assert.equal(state.visits.includes('/listings/draft'), false);
    assert.equal((await browser.pages()).length, tabs);
    assert.match(logs.at(-1), /deletion verified/);
    assert.equal(await page.$eval('#profile', el => el.matches(':hover')), false);
});

test('missing Oldest option stops without deleting any listing', async () => {
    state.sortBroken = true;
    await assert.rejects(controls.deleteOldestListing(page, () => {}, NEW), /Waiting failed/);
    assert.deepEqual(state.deleted, []);
});

test('failed server deletion is reported, not counted as successful', async () => {
    state.rejectDelete = true;
    await assert.rejects(controls.deleteOldestListing(page, () => {}, NEW), /still On Sale/);
    assert.deepEqual(state.listings, [RECENT, OLD]);
});

test('the newly published listing is protected when it is the only listing', async () => {
    state.listings = [NEW];
    await assert.rejects(controls.deleteOldestListing(page, () => {}, NEW), /newly posted listing/);
    assert.deepEqual(state.deleted, []);
});

test('checkbox off posts once without visiting On Sale or deleting', async () => {
    const main = mainProcess();
    const tabs = (await browser.pages()).length;
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: false });
    assert.equal(result.success, true);
    assert.equal(result.postedCount, 1, JSON.stringify({ result, logs: main.logs }));
    assert.equal(state.posts, 1);
    assert.deepEqual(state.deleted, []);
    assert.equal(state.visits.includes('/listings/onsale'), false);
    assert.equal((await browser.pages()).length, tabs);
    assert.equal(main.closed(), true);
});

test('checkbox on confirms a post then deletes exactly one oldest listing', async () => {
    const count = state.listings.length;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: true });
    assert.equal(result.success, true);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.deepEqual(state.deleted, [OLD]);
    assert.equal(state.listings.length, count);
    assert.ok(state.visits.indexOf('/fixture/publish') < state.visits.indexOf('/fixture/delete'));
});

test('rejected post never triggers deletion', async () => {
    state.rejectPost = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: true });
    assert.equal(result.success, false);
    assert.equal(result.postedCount, 0);
    assert.deepEqual(state.deleted, []);
    assert.equal(main.closed(), true);
});

test('maintenance failure stops further posts and retains the confirmed count', async () => {
    state.drafts = 2;
    state.rejectDelete = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: true, loop: true });
    assert.equal(result.success, false);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.match(result.error, /still On Sale/);
});

test('overlapping runs are rejected and Stop interrupts the rate-limit wait', async () => {
    state.drafts = 2;
    const main = mainProcess();
    const run = main.handlers.get('process-drafts')({ sender: {} }, {});
    try {
        await new Promise((resolve, reject) => {
            const deadline = Date.now() + 15000;
            const check = () => {
                if (main.logs.some(message => message.includes('Rate Limit Protection'))) return resolve();
                if (Date.now() > deadline) return reject(new Error('Did not reach rate-limit wait'));
                global.setTimeout(check, 20);
            };
            check();
        });
    } catch (error) {
        await main.handlers.get('stop-drafts')();
        await run;
        throw error;
    }
    const overlap = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(overlap.success, false);
    assert.match(overlap.error, /already running/);
    await main.handlers.get('stop-drafts')();
    const result = await run;
    assert.equal(result.success, true);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
});

test('a one-draft continuous loop still waits for the posting rate limit', async () => {
    const main = mainProcess();
    const run = main.handlers.get('process-drafts')({ sender: {} }, { loop: true });
    try {
        await page.waitForFunction(() => location.pathname.startsWith('/item/'), { timeout: 10000 });
        const deadline = Date.now() + 5000;
        while (!main.logs.some(message => message.includes('Rate Limit Protection'))) {
            assert.ok(Date.now() < deadline, 'Expected rate-limit wait before restarting the loop');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    } finally {
        await main.handlers.get('stop-drafts')();
    }
    const result = await run;
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
});

test('the GUI captures the checkbox and locks settings until posting finishes', async () => {
    await page.evaluate(() => {
        window.calls = [];
        window.require = () => ({ ipcRenderer: {
            on() {}, send() {},
            invoke: async (channel, config) => {
                window.calls.push({ channel, config });
                if (channel === 'process-drafts') return new Promise(resolve => window.finishRun = resolve);
                return { success: true };
            }
        }});
    });
    await page.setContent(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
    await page.click('#maintainLimit');
    await page.click('#startBtn');
    assert.equal(await page.evaluate(() => window.calls[0].config.maintainLimit), true);
    assert.equal(await page.$$eval('.settings-grid input', els => els.every(el => el.disabled)), true);
    await page.click('#stopBtn');
    assert.equal(await page.evaluate(() => window.calls.at(-1).channel), 'stop-drafts');
    await page.evaluate(() => window.finishRun({ success: false, postedCount: 1, error: 'Deletion not confirmed' }));
    await page.waitForFunction(() => !document.querySelector('#maintainLimit').disabled);
    assert.match(await page.$eval('#logContainer', el => el.textContent), /paused after 1 confirmed posts: Deletion not confirmed/);
    assert.equal(await page.$eval('#maintainLimit', el => el.checked), true);
});
