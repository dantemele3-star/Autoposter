const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const puppeteer = require('puppeteer');
const controls = require('../listing-controls');
const drafts = require('../drafts');
const { ActionPacer, setPagePacer } = require('../pacing');
const budgets = require('../posting-budget');

const OLD = '11111111-1111-4111-8111-111111111111';
const RECENT = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';
const NEXT = '44444444-4444-4444-8444-444444444444';
const itemUrl = id => `https://gameflip.com/item/example/${id}`;
let browser, page, state;
const stateFolders = [];

before(async () => {
    browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: process.env.CI ? ['--no-sandbox'] : []
    });
});
after(async () => browser?.close());
beforeEach(async () => {
    state = { listings: [RECENT, OLD], visits: [], requests: [], deleted: [], published: [], timers: [], posts: 0, drafts: 1 };
    page = await browser.newPage();
    let actionClock = 0;
    setPagePacer(page, new ActionPacer({ now: () => actionClock, sleep: async ms => { actionClock += ms; } }));
    const setPageTimeout = page.setDefaultTimeout.bind(page);
    page.setDefaultTimeout = ms => setPageTimeout(Math.min(ms, 1500));
    page.setDefaultTimeout(1500);
    await page.setRequestInterception(true);
    page.on('request', async request => {
        const url = new URL(request.url());
        state.visits.push(url.pathname);
        state.requests.push(url.href);
        let body;
        if (url.pathname === '/fixture/sorted') {
            await new Promise(resolve => global.setTimeout(resolve, 80));
            body = JSON.stringify([...state.listings].sort());
        } else if (url.pathname === '/fixture/publish') {
            if (!state.rejectPost) {
                state.posts++;
                state.published.push(url.searchParams.get('id'));
                const currentState = state;
                const activate = () => currentState.listings.unshift(url.searchParams.get('id'));
                if (state.indexDelay) state.timers.push(global.setTimeout(activate, state.indexDelay));
                else activate();
                state.afterPost?.();
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
afterEach(async () => {
    for (const timer of state.timers) clearTimeout(timer);
    await page?.close();
    for (const folder of stateFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

// Every browser request is intercepted. No account, cookie or Gameflip network
// access is used; these fixtures reproduce the competing navigation/dropdowns.
function fixture(url) {
    const id = controls.listingId(url.href);
    let content = '';
    if (url.pathname === '/listings/draft') {
        const pages = state.draftPages || [[NEW, NEXT].slice(0, state.drafts)];
        const number = state.ignorePage ? 1 : Number(url.searchParams.get('page') || 1);
        const ids = pages[number - 1] || [];
        content = ids.map(id => state.copyWrapper
            ? `<div data-listing-id="${id}"><a href="/item/source/${id}">Source draft</a>
                <span class="tool-duplicate"><button onpointerdown="window.pressed=true"
                    onclick="if(window.pressed) location.href='/listings/${id}/edit'">Copy</button></span></div>`
            : `<a class="tool-duplicate" target="_blank" href="${state.sharedCopyLink ? '/listings/copy' : state.queryEditor ? `/listing/edit?id=${id}` : `/listings/${id}/edit` }"
                ${state.blockCopy ? 'onclick="event.preventDefault()"' : ''}>Create a copy in Draft</a>`).join('');
        if (state.pager === 'none') {
            content += '<section><button disabled>Next</button></section>';
        } else if (state.pager === 'buttons') {
            content += `<div class="paginator"><button aria-label="Next page" ${number >= pages.length ? 'disabled' : ''}>›</button></div>`;
        } else if (state.pager === 'numbers') {
            content += '<div class="pagination">' + pages.map((_, index) =>
                `<button ${index + 1 === number ? 'aria-current="page"' : ''}>${index + 1}</button>`).join('') + '</div>';
        } else {
            content += `<ul class="pagination"><li ${number >= pages.length ? 'class="disabled"' : ''}>
                <a aria-label="Next" href="?page=${number + 1}&limit=50">Next</a></li></ul>`;
        }
        if (state.popup) content += '<div class="modal" role="dialog"><button onclick="this.parentElement.style.display=\'none\'">Not now</button></div>';
    } else if (url.pathname.endsWith('/edit')) {
        const preview = state.queryEditor ? `/listing/preview?id=${id}` : `/listings/${id}/preview`;
        content = state.anchorDone
            ? `<a class="btn" href="${preview}">Done</a>`
            : `<button onclick="location.href='${preview}'">Done</button>`;
    } else if (url.pathname.endsWith('/preview')) {
        content = `<button onclick="fetch('/fixture/publish?id=${id}').then(() => {
            ${state.rejectPost ? "document.querySelector('#error').textContent='Post rejected'" : state.stayPreview
                ? '' : state.publishToOnSale ? "location.href='/listings/onsale'" : `location.href='/item/example/${id}'`}
        })">List Item</button><div id="error" role="alert"></div>`;
    } else if (url.pathname === '/listings/onsale') {
        const saleIds = state.salePages ? state.salePages[Number(url.searchParams.get('page') || 1) - 1] || [] : state.listings;
        content = `${state.saleListButton ? '<button>List Item</button>' : ''}<div class="dropdown" id="sort">
            <button class="dropdown-toggle" onclick="this.parentElement.classList.toggle('open')">Created: Newest</button>
            <div class="dropdown-menu">${state.sortBroken ? '' : `<button onclick="sortOldest()">Oldest</button>`}</div>
        </div><div id="rows">${links(saleIds)}</div>
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

function mainProcess({ random = Math.random, skipWaits = false, stateFolder } = {}) {
    if (!stateFolder) {
        stateFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-state-test-'));
        stateFolders.push(stateFolder);
    }
    const handlers = new Map();
    const logs = [];
    const win = { isDestroyed: () => false, webContents: { send: (_, message) => logs.push(message) } };
    let closed = false;
    const fakeBrowser = { pages: async () => [page], close: async () => { closed = true; } };
    const electron = {
        app: { getPath: () => stateFolder, whenReady: () => ({ then() {} }), requestSingleInstanceLock: () => true, quit() {} },
        BrowserWindow: { fromWebContents: () => win },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }
    };
    let clock = Date.now();
    class TestClock extends Date { static now() { return clock += 300000; } }
    const testingControls = { ...controls, waitForPublished: (target, context, options) =>
        controls.waitForPublished(target, context, { ...options, timeoutMs: 1500, retryDelayMs: 50 }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), {
        require: name => name === 'electron' ? electron : name === 'puppeteer'
            ? { launch: async () => fakeBrowser } : name === './listing-controls' ? testingControls
                : name === './drafts' ? drafts : name === './posting-budget' ? budgets : require(name),
        process, console, setTimeout: global.setTimeout, Math: Object.create(Math, { random: { value: random } }),
        Date: skipWaits ? TestClock : Date
    });
    return { handlers, logs, stateFolder, closed: () => closed };
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

const sourceId = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const sourceIds = (start, count) => Array.from({ length: count }, (_, index) => sourceId(start + index));

test('scans full pages without recognizable pagination and indexes every draft', async () => {
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 50), sourceIds(200, 3)];
    state.pager = 'none';
    const queue = await drafts.scanDrafts(page, () => {});
    assert.equal(queue.length, 103);
    assert.equal(new Set(queue.map(draft => draft.key)).size, 103);
    assert.deepEqual(queue.at(-1), { key: sourceId(202), index: 2, page: 3 });
    const requested = state.requests.map(value => new URL(value)).filter(url => url.pathname === '/listings/draft');
    assert.deepEqual(requested.map(url => url.searchParams.get('page')), ['1', '2', '3']);
    assert.ok(requested.every(url => url.searchParams.get('limit') === '50'));
    assert.equal(state.posts, 0);
});

for (const pager of ['buttons', 'numbers']) {
    test(`scans all drafts with ${pager} pagination and a short first page`, async () => {
        state.draftPages = [[NEW, NEXT], [sourceId(500)]];
        state.pager = pager;
        const queue = await drafts.scanDrafts(page, () => {});
        assert.deepEqual(queue.map(draft => draft.key), [NEW, NEXT, sourceId(500)]);
        assert.equal(queue.at(-1).page, 2);
    });
}

test('an exact multiple of 50 is completed by checking the following empty page', async () => {
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 50)];
    state.pager = 'none';
    const queue = await drafts.scanDrafts(page, () => {});
    assert.equal(queue.length, 100);
    assert.ok(state.requests.some(value => new URL(value).searchParams.get('page') === '3'));
});

test('a server that repeats page one pauses before posting any partial queue', async () => {
    state.draftPages = [sourceIds(100, 50)];
    state.pager = 'none';
    state.ignorePage = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /page 2 repeated/);
    assert.equal(result.postedCount, 0);
    assert.equal(state.posts, 0);
    assert.equal(state.visits.some(value => value.endsWith('/edit')), false);
});

test('ambiguous copy links pause during scanning instead of collapsing the queue to one item', async () => {
    state.drafts = 2;
    state.sharedCopyLink = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /Multiple draft rows share the same identity/);
    assert.equal(result.postedCount, 0);
    assert.equal(main.logs.some(message => message.includes('Processing Item')), false);
});

test('Stop during a multi-page scan returns no posting queue', async () => {
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 50), [sourceId(200)]];
    state.pager = 'none';
    let stopped = false;
    const queue = await drafts.scanDrafts(page, message => {
        if (message === 'Found 50 drafts on page 2.') stopped = true;
    }, () => stopped);
    assert.deepEqual(queue, []);
    assert.equal(state.posts, 0);
});

test('selects the original draft ID after a new row shifts its scanned index', async () => {
    const queue = await drafts.scanDrafts(page, () => {});
    state.draftPages = [[sourceId(900), NEW]];
    await drafts.openDraft(page, queue[0], () => {});
    assert.equal(page.url(), `https://gameflip.com/listings/${NEW}/edit`);
});

test('two consecutive posts still use the original queue when drafts move between pages', async () => {
    state.draftPages = [[NEW], [NEXT]];
    state.afterPost = () => {
        if (state.posts === 1) state.draftPages = [[NEXT, sourceId(900)], [NEW]];
    };
    const main = mainProcess({ skipWaits: true });
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 2);
    assert.deepEqual(state.published, [NEW, NEXT]);
    assert.ok(main.logs.some(message => message.includes('locating it by listing ID')));
});

test('finishes all 53 drafts before randomizing and opening a draft from page two', async () => {
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 3)];
    state.pager = 'none';
    let randomCalls = 0;
    const main = mainProcess({ random: () => randomCalls++ === 0 ? 0 : 0.999999 });
    let outcome;
    const run = main.handlers.get('process-drafts')({ sender: {} }, { randomize: true })
        .then(result => { outcome = result; return result; });
    try {
        const deadline = Date.now() + 15000;
        while (!main.logs.some(message => message.includes('Rate Limit Protection'))) {
            assert.equal(outcome, undefined, outcome?.error || 'Run ended before processing the full queue');
            assert.ok(Date.now() < deadline, 'Did not reach the inter-post wait');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    } finally {
        await main.handlers.get('stop-drafts')();
        await run;
    }
    assert.equal(outcome.success, true, outcome.error);
    assert.equal(outcome.postedCount, 1);
    assert.deepEqual(state.published, [sourceId(152)]);
    const complete = main.logs.findIndex(message => message.includes('Scan complete: 53 unique drafts'));
    assert.ok(complete >= 0);
    assert.ok(complete < main.logs.findIndex(message => message.includes('Randomizing processing order')));
    assert.ok(complete < main.logs.findIndex(message => message.includes('Processing Item 1/53')));
    const requests = state.requests.map(value => new URL(value));
    const pageTwo = requests.findIndex(url => url.pathname === '/listings/draft' && url.searchParams.get('page') === '2');
    const firstCopy = requests.findIndex(url => url.pathname.endsWith('/edit'));
    assert.ok(pageTwo >= 0 && pageTwo < firstCopy);
});

test('clicks the real copy button inside its wrapper and accepts an anchor Done control', async () => {
    state.copyWrapper = true;
    state.anchorDone = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
});

test('dismisses a promotion modal before clicking the draft copy control', async () => {
    state.popup = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
});

test('a copy action that stays on Drafts identifies the exact missing step', async () => {
    state.blockCopy = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /Done control in the draft editor on \/listings\/draft/);
    assert.equal(result.postedCount, 0);
    assert.equal(state.posts, 0);
});

test('recognizes On Sale despite its List Item button and reads the copied ID from query parameters', async () => {
    state.queryEditor = true;
    state.publishToOnSale = true;
    state.saleListButton = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(main.stateFolder, 'posting-history.json'))).submissions.length, 1);
});

test('reads a copied listing ID from its form when the preview URL has no ID', async () => {
    await page.setContent(`<header><form><input name="id" value="${OLD}" type="hidden"><button>List Item</button></form></header>
        <form><input name="listing_id" value="${NEW}" type="hidden"><button>List Item</button></form>`);
    const context = await controls.capturePublication(page);
    assert.equal(context.id, NEW);
});

test('finds the submitted listing on a later On Sale page without resubmitting', async () => {
    state.publishToOnSale = true;
    state.afterPost = () => { state.salePages = [sourceIds(500, 50), [NEW]]; };
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.ok(state.requests.some(value => {
        const url = new URL(value);
        return url.pathname === '/listings/onsale' && url.searchParams.get('page') === '2';
    }));
});

test('rechecks delayed On Sale indexing without posting the listing twice', async () => {
    state.publishToOnSale = true;
    state.indexDelay = 1100;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
});

test('a submitted listing left on the preview is verified read-only after the UI wait', async () => {
    state.stayPreview = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
});

test('publication observation can outwait the ordinary page timeout and a visible List Item button', async () => {
    await page.setContent('<button>List Item</button><div id="feedback"></div>');
    const context = await controls.capturePublication(page);
    page.setDefaultTimeout(75);
    await page.evaluate(() => setTimeout(() => {
        document.querySelector('#feedback').innerHTML = '<div role="status">Your item was listed successfully.</div>';
    }, 300));
    assert.equal(await controls.waitForPublished(page, context, { timeoutMs: 1000 }), null);
});

test('actual browser click events are separated by at least the action delay', async () => {
    setPagePacer(page);
    await page.setContent('<button onclick="window.clicks.push(performance.now())">Done</button>');
    await page.evaluate(() => { window.clicks = []; });
    await controls.clickControl(page, 'done');
    await controls.clickControl(page, 'done');
    const clicks = await page.evaluate(() => window.clicks);
    assert.equal(clicks.length, 2);
    assert.ok(clicks[1] - clicks[0] >= 1990, 'Clicks were not paced by two seconds');
});

test('finds a freshly rendered control after the action pause', async () => {
    await page.setContent('<button>Done</button>');
    let clock = 0;
    setPagePacer(page, new ActionPacer({ now: () => clock, sleep: async ms => {
        clock += ms;
        await page.evaluate(() => {
            document.querySelector('button').outerHTML = '<button onclick="window.clicked=true">Done</button>';
        });
    } }));
    await controls.clickControl(page, 'done');
    assert.equal(await page.evaluate(() => window.clicked), true);
});

test('restarting after one post preserves the cooldown before any new website action', async () => {
    const first = mainProcess();
    assert.equal((await first.handlers.get('process-drafts')({ sender: {} }, {})).postedCount, 1);
    const requestCount = state.requests.length;
    const second = mainProcess({ stateFolder: first.stateFolder });
    const run = second.handlers.get('process-drafts')({ sender: {} }, {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(second.logs.some(message => message.includes('220-second minimum')));
    assert.equal(state.requests.length, requestCount);
    await second.handlers.get('stop-drafts')();
    assert.equal((await run).postedCount, 0);
    assert.equal(state.posts, 1);
});

test('reaching 400 recorded submissions stops before the next draft is submitted', async () => {
    state.drafts = 2;
    const main = mainProcess();
    fs.writeFileSync(path.join(main.stateFolder, 'posting-history.json'), JSON.stringify({
        version: 1, cooldownUntil: 0,
        submissions: Array.from({ length: 399 }, (_, index) => Date.now() - (400 - index) * 1000)
    }));
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /Daily limit reached: 400/);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(main.stateFolder, 'posting-history.json'))).submissions.length, 400);
});

test('missing Oldest option stops without deleting any listing', async () => {
    state.sortBroken = true;
    await assert.rejects(controls.deleteOldestListing(page, () => {}, NEW), /Oldest option/);
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

test('checkbox off verifies the post using a read-only On Sale check without deleting', async () => {
    const main = mainProcess();
    const tabs = (await browser.pages()).length;
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: false });
    assert.equal(result.success, true);
    assert.equal(result.postedCount, 1, JSON.stringify({ result, logs: main.logs }));
    assert.equal(state.posts, 1);
    assert.deepEqual(state.deleted, []);
    assert.equal(state.visits.includes('/listings/onsale'), true);
    assert.equal(state.visits.includes('/fixture/delete'), false);
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
