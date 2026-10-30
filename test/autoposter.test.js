const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const puppeteer = require('puppeteer');
const controls = require('../listing-controls');
const drafts = require('../drafts');
const { ActionPacer, setPagePacer } = require('../pacing');
const budgets = require('../posting-budget');
const diagnostics = require('../run-log');

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
    state = { listings: [RECENT, OLD], visits: [], requests: [], deleted: [], published: [], posts: 0, drafts: 1 };
    page = await browser.newPage();
    let actionClock = 0;
    setPagePacer(page, new ActionPacer({ now: () => actionClock, sleep: async ms => { actionClock += ms; } }));
    const setPageTimeout = page.setDefaultTimeout.bind(page);
    page.setDefaultTimeout = ms => setPageTimeout(Math.min(ms, 5000));
    page.setDefaultTimeout(1500);
    // Keep missing-control failures fast without applying that shortened test
    // timeout to Chromium navigations on a loaded cloud worker.
    page.setDefaultNavigationTimeout(30000);
    await page.setRequestInterception(true);
    page.on('request', async request => {
        const url = new URL(request.url());
        state.visits.push(url.pathname);
        state.requests.push(url.href);
        let body;
        if (url.pathname === '/api/listings') {
            if (state.draftDataNeverReady) return;
            await new Promise(resolve => global.setTimeout(resolve, state.draftDataDelay));
            try { await request.respond({ status: 200, contentType: 'application/json', body: '{}' }); }
            catch (error) {
                if (!/closed|No resource|Invalid InterceptionId/i.test(error.message)) throw error;
            }
            return;
        } else if (url.pathname === '/fixture/background') {
            // Polling keeps the draft document busy. Individual responses still
            // complete, so leaving that document can drain the outstanding work.
            await new Promise(resolve => global.setTimeout(resolve, 150));
            try { await request.respond({ status: 200, contentType: 'application/json', body: '{}' }); }
            catch (error) {
                if (!/closed|No resource|Invalid InterceptionId/i.test(error.message)) throw error;
            }
            return;
        } else if (url.pathname === '/fixture/sorted') {
            await new Promise(resolve => global.setTimeout(resolve, 80));
            body = JSON.stringify([...state.listings].sort());
        } else if (url.pathname === '/fixture/publish') {
            if (!state.rejectPost) {
                state.posts++;
                state.published.push(url.searchParams.get('id'));
                const currentState = state;
                const activate = () => currentState.listings.unshift(url.searchParams.get('id'));
                if (state.indexAfterSaleReads) state.pendingIndex = activate;
                else activate();
                state.afterPost?.();
            }
            body = '{}';
        } else if (url.pathname === '/fixture/delete') {
            const id = url.searchParams.get('id');
            state.deleted.push(id);
            if (!state.rejectDelete) state.listings = state.listings.filter(value => value !== id);
            body = '{}';
        } else if (url.pathname === '/fixture/decline' || url.pathname === '/fixture/accept') {
            const key = url.pathname.endsWith('/decline') ? 'declines' : 'accepts';
            state[key] = (state[key] || 0) + 1;
            body = '{}';
        } else {
            body = fixture(url);
        }
        await request.respond({ status: state.documentStatus?.(url) || 200,
            contentType: url.pathname.startsWith('/fixture/') ? 'application/json' : 'text/html', body });
    });
});
afterEach(async () => {
    await page?.close();
    for (const folder of stateFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

// Every browser request is intercepted. No account, cookie or Gameflip network
// access is used; these fixtures reproduce the competing navigation/dropdowns.
function fixture(url) {
    const id = controls.listingId(url.href);
    const backgroundPolling = '<script>fetch("/fixture/background").catch(() => {}); setInterval(() => fetch("/fixture/background").catch(() => {}), 100)</script>';
    let content = '';
    if (url.pathname === '/listings/draft') {
        const pages = state.draftPages || [[NEW, NEXT].slice(0, state.drafts)];
        const number = state.ignorePage ? 1 : Number(url.searchParams.get('page') || 1);
        const ids = pages[number - 1] || [];
        if (!ids.length && !state.blankDraftPage) content += '<p class="empty-state">No drafts found.</p>';
        content += ids.map(id => state.copyWrapper
            ? `<div data-listing-id="${id}"><a href="/item/source/${id}">Source draft</a>
                <span class="tool-duplicate"><button onpointerdown="window.pressed=true"
                    onclick="if(window.pressed) location.href='/listings/${id}/edit'">Copy</button></span></div>`
            : `<a class="${state.decorativeCopyIcons ? '' : 'tool-duplicate'}" target="_blank" href="${state.sharedCopyLink ? '/listings/copy' : state.queryEditor ? `/listing/edit?id=${id}` : `/listings/${id}/edit` }"
                ${state.blockCopy ? 'onclick="event.preventDefault()"' : ''}>${state.decorativeCopyIcons ? '<span class="tool-duplicate" aria-hidden="true">Copy</span>' : 'Create a copy in Draft'}</a>`).join('');
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
        if (state.backgroundDraftTraffic) content += backgroundPolling;
        if (state.draftRowDelay || state.draftsNeverReady || state.blankDraftPage) content += `<script>
            const region = document.querySelector('.listings-container');
            const copies = [...region.querySelectorAll('.tool-duplicate')];
            const savedRows = copies.map(el => el.outerHTML);
            copies.forEach(el => el.remove());
            ${state.blankDraftPage ? '' : state.draftLoadingIcon
                ? `region.insertAdjacentHTML('beforeend', '<span class="spinner" aria-hidden="true">Loading drafts...</span>');`
                : `region.setAttribute('aria-busy', 'true');`}
            ${state.draftRowDelay ? `setTimeout(() => region.insertAdjacentHTML('beforeend', savedRows.slice(0, 1).join('')), 100);
                setTimeout(() => { region.insertAdjacentHTML('beforeend', savedRows.slice(1).join(''));
                    region.setAttribute('aria-busy', 'false'); region.querySelector('.spinner')?.remove(); }, ${state.draftRowDelay});` : ''}
        </script>`;
        if (state.draftDataDelay || state.draftDataNeverReady) content += `<script>
            const region = document.querySelector('.listings-container');
            const remaining = [...region.querySelectorAll('.tool-duplicate')].slice(1);
            const savedRows = remaining.map(el => el.outerHTML);
            remaining.forEach(el => el.remove());
            fetch('/api/listings?page=${number}').then(response => response.json()).then(() => {
                region.insertAdjacentHTML('beforeend', savedRows.join(''));
            });
        </script>`;
    } else if (url.pathname.endsWith('/edit')) {
        const preview = state.queryEditor ? `/listing/preview?id=${id}` : `/listings/${id}/preview`;
        content = state.anchorDone
            ? `<a class="btn" href="${preview}">Done</a>`
            : `<button onclick="location.href='${preview}'">Done</button>`;
    } else if (url.pathname.endsWith('/preview')) {
        const prompt = state.postPopup === 'iframe'
            ? '<iframe id="notification-frame" src="https://notifications.example.test/notification-prompt" style="position:fixed;inset:10px;width:500px;height:300px"></iframe>'
            : notificationPrompt(state.stickyPrompt ? '' : 'declinePrompt()', state.postPopup === 'custom');
        content = `<button onclick="submitFixtureListing()">List Item</button><div id="error" role="alert"></div>
            <script>
                function declinePrompt() { fetch('/fixture/decline').then(() => location.href='/listings/onsale'); }
                window.addEventListener('message', event => { if(event.data === 'declined') {
                    document.querySelector('#notification-frame').remove(); declinePrompt();
                }});
                async function submitFixtureListing() {
                    await fetch('/fixture/publish?id=${id}');
                    ${state.rejectPost ? "document.querySelector('#error').textContent='Post rejected'" : state.postPopup
                        ? `setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(prompt)}), ${state.popupDelay || 0});`
                        : state.stayPreview ? '' : state.publishToOnSale ? "location.href='/listings/onsale'" : `location.href='/item/example/${id}'`}
                }
            </script>`;
    } else if (url.pathname === '/notification-prompt') {
        content = notificationPrompt("parent.postMessage('declined', '*')");
    } else if (url.pathname === '/listings/onsale') {
        if (state.pendingIndex && (state.saleReads = (state.saleReads || 0) + 1) >= state.indexAfterSaleReads) {
            state.pendingIndex();
            state.pendingIndex = null;
        }
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
        if (state.salePopup) content += notificationPrompt("fetch('/fixture/decline'); this.closest('.notification-prompt').remove()");
        if (state.backgroundOnSaleTraffic) content += backgroundPolling;
    } else if (id) {
        const icon = state.actionIcon === 'svg' ? '<svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="2" /></svg>'
            : `<i class="${state.actionIcon || 'fa-ellipsis-h'}" aria-hidden="true"></i>`;
        const menu = `<div id="listing-actions-menu" class="dropdown-menu" role="menu">
            <a role="menuitem" href="#" ${state.titleOnlyDelete ? 'title="Delete listing"' : ''}
                onclick="event.preventDefault(); document.querySelector('.modal').style.display='block'">
                ${state.textOnlyDelete ? '' : '<span class="fa-trash"></span>'}${state.titleOnlyDelete ? '' : 'Delete listing'}</a></div>`;
        const toggle = `onclick="document.querySelector('#listing-actions-menu').style.display='block'"`;
        const tag = state.spanToggle ? 'span' : 'button';
        content = `${state.portalMenu ? `<button aria-controls="listing-actions-menu" aria-haspopup="menu" aria-label="Listing actions" ${toggle}>${icon}</button>${menu}`
            : `<div class="dropdown" id="actions"><${tag} class="dropdown-toggle" aria-label="Listing actions" ${toggle}>${icon}</${tag}>${menu}</div>`}
        <div class="dropdown" id="account-outside-header">
            <button onclick="window.wrongMenu=true"><i class="fa-power-off"></i>Account</button>
            <div class="dropdown-menu"><a href="/logout">Log out</a><button>Delete</button></div>
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

function notificationPrompt(decline, custom = false) {
    const tag = custom ? 'div' : 'button';
    return `<div class="notification-prompt" style="position:fixed;inset:20px;background:#252225;z-index:1000">
        <div>BE THE FIRST!</div><p>Receive instant order updates, account alerts and special discounts?</p>
        <div><button onclick="fetch('/fixture/accept')">YES</button>
            <${tag} onclick="${decline}"><span>NOT</span> <span>NOW</span></${tag}></div></div>`;
}

function mainProcess({ random = Math.random, skipWaits = false, stateFolder, launchError, closeError, clipboard,
    publicationTimeoutMs = 1500, onLog = () => {} } = {}) {
    if (!stateFolder) {
        stateFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-state-test-'));
        stateFolders.push(stateFolder);
    }
    const handlers = new Map();
    const logs = [];
    const openedLogs = [];
    const win = { isDestroyed: () => false, webContents: { send: (_, message) => { logs.push(message); onLog(message); } } };
    let closed = false;
    const fakeBrowser = Object.assign(new EventEmitter(), { pages: async () => [page], close: async () => {
        closed = true;
        if (closeError) throw closeError;
    } });
    const electron = {
        app: { getPath: () => stateFolder, whenReady: () => ({ then() {} }), requestSingleInstanceLock: () => true, quit() {} },
        BrowserWindow: { fromWebContents: () => win },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
        clipboard,
        shell: { showItemInFolder: file => openedLogs.push(['file', file]),
            openPath: async folder => { openedLogs.push(['folder', folder]); return ''; } }
    };
    let clock = Date.now();
    class TestClock extends Date { static now() { return clock += 300000; } }
    const testingControls = { ...controls, waitForPublished: (target, context, options) =>
        controls.waitForPublished(target, context, { ...options, timeoutMs: publicationTimeoutMs, retryDelayMs: 50 }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), {
        require: name => name === 'electron' ? electron : name === 'puppeteer'
            ? { launch: async () => { if (launchError) throw launchError; return fakeBrowser; } } : name === './listing-controls' ? testingControls
                : name === './drafts' ? drafts : name === './posting-budget' ? budgets
                    : name === './run-log' ? diagnostics : name === './package.json' ? require('../package.json') : require(name),
        process, console, setTimeout: global.setTimeout, Math: Object.create(Math, { random: { value: random } }),
        Date: skipWaits ? TestClock : Date
    });
    return { handlers, logs, stateFolder, openedLogs, closed: () => closed };
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

for (const actionIcon of ['fa-power-off', 'fa-ellipsis-v', 'fa-cog', 'svg']) {
    test(`oldest deletion uses the seller menu with ${actionIcon} controls rather than the account power icon`, async () => {
        state.actionIcon = actionIcon;
        state.textOnlyDelete = true;
        state.listings.unshift(NEW);
        await controls.deleteOldestListing(page, () => {}, NEW);
        assert.deepEqual(state.deleted, [OLD]);
        assert.deepEqual(state.listings, [NEW, RECENT]);
        assert.equal(state.visits.includes('/logout'), false);
    });
}

test('oldest deletion follows an explicitly associated menu outside the dropdown container', async () => {
    state.portalMenu = true;
    state.actionIcon = 'svg';
    state.textOnlyDelete = true;
    state.listings.unshift(NEW);
    await controls.deleteOldestListing(page, () => {}, NEW);
    assert.deepEqual(state.deleted, [OLD]);
    assert.equal(state.visits.includes('/logout'), false);
});

test('oldest deletion accepts a non-button dropdown toggle and an icon-only Delete entry with a title', async () => {
    state.spanToggle = true;
    state.titleOnlyDelete = true;
    state.actionIcon = 'svg';
    state.listings.unshift(NEW);
    await controls.deleteOldestListing(page, () => {}, NEW);
    assert.deepEqual(state.deleted, [OLD]);
});

test('missing, disabled, hidden and ambiguous seller controls cannot select a profile or other Delete menu', async () => {
    await controls.navigate(page, itemUrl(OLD));
    await page.evaluate(() => {
        window.originalActions = document.querySelector('#actions').outerHTML;
        document.querySelector('#actions').remove();
        document.querySelector('#account-outside-header .dropdown-menu').style.display = 'block';
    });
    assert.equal(await page.evaluate(controls.findControl, 'listing-actions'), null);
    assert.equal(await page.evaluate(controls.findControl, 'trash'), null);
    await page.evaluate(() => {
        document.querySelector('.listings-container').insertAdjacentHTML('afterbegin', window.originalActions);
        document.querySelector('#actions > button').disabled = true;
    });
    assert.equal(await page.evaluate(controls.findControl, 'listing-actions'), null);
    await page.evaluate(() => {
        document.querySelector('#actions > button').disabled = false;
        document.querySelector('#actions > button').style.display = 'none';
    });
    assert.equal(await page.evaluate(controls.findControl, 'listing-actions'), null);
    await page.evaluate(() => {
        document.querySelector('#actions > button').style.display = '';
        document.querySelector('#actions [role="menuitem"]').setAttribute('aria-disabled', 'true');
    });
    assert.equal(await page.evaluate(controls.findControl, 'listing-actions'), null);
    await page.evaluate(() => {
        document.querySelector('#actions [role="menuitem"]').removeAttribute('aria-disabled');
        document.querySelector('.listings-container').insertAdjacentHTML('beforeend',
            '<div class="dropdown"><button>Other actions</button><div class="dropdown-menu"><button>Delete</button></div></div>');
    });
    await assert.rejects(controls.clickControl(page, 'listing-actions'), /unambiguous listing action menu/);
    assert.deepEqual(state.deleted, []);
    assert.equal(await page.evaluate(() => !!window.wrongMenu), false);
});

const sourceId = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const sourceIds = (start, count) => Array.from({ length: count }, (_, index) => sourceId(start + index));

// Reproduce Chromium exposing a revalidation response while its cached HTML
// remains rendered. Intercepted HTTP 304 alone has no browser-cache body.
function cachedNavigation(matches) {
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
        const response = await goto(url, options);
        return matches(new URL(url)) ? { ok: () => false, status: () => 304 } : response;
    };
}

for (const cachedPage of [1, 2]) {
    test(`cached HTTP 304 on draft page ${cachedPage} still produces the complete queue`, async () => {
        state.draftPages = [sourceIds(100, 50), [sourceId(150)]];
        cachedNavigation(url => url.pathname === '/listings/draft' && Number(url.searchParams.get('page')) === cachedPage);
        const queue = await drafts.scanDrafts(page, () => {});
        assert.equal(queue.length, 51);
        assert.equal(queue.at(-1).key, sourceId(150));
        assert.equal(state.posts, 0);
    });
}

test('an empty 304 cache response is checked without cache before ending the scan', async () => {
    state.draftPages = [sourceIds(100, 50), [sourceId(150)]];
    const goto = page.goto.bind(page);
    let cacheMiss = true;
    page.goto = async (url, options) => {
        const response = await goto(url, options);
        if (new URL(url).searchParams.get('page') === '2' && cacheMiss) {
            cacheMiss = false;
            await page.setContent('<!doctype html><body></body>');
            return { ok: () => false, status: () => 304 };
        }
        return response;
    };
    const logs = [];
    const queue = await drafts.scanDrafts(page, message => logs.push(message));
    assert.equal(queue.length, 51);
    assert.equal(state.requests.filter(url => new URL(url).searchParams.get('page') === '2').length, 2);
    assert.ok(logs.some(message => message.includes('checking once without cache')));
});

test('cached drafts and On Sale verification complete without resubmitting', async () => {
    state.publishToOnSale = true;
    cachedNavigation(url => ['/listings/draft', '/listings/onsale'].includes(url.pathname));
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.deepEqual(state.deleted, []);
});

test('304 without cached content cannot silently end a partially scanned queue', async () => {
    state.draftPages = [sourceIds(100, 50), []];
    cachedNavigation(url => url.searchParams.get('page') === '2');
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /page 2 still has no usable cached draft content/);
    assert.equal(state.posts, 0);
    assert.equal(main.logs.some(message => message.includes('Scan complete')), false);
});

test('304 does not bypass the repeated-page safeguard or expose a partial queue', async () => {
    state.draftPages = [sourceIds(100, 50)];
    state.pager = 'none';
    state.ignorePage = true;
    cachedNavigation(() => true);
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /page 2 repeated/);
    assert.equal(state.posts, 0);
    assert.equal(main.closed(), true);
});

test('an HTTP failure records the scan step, exact page, status, and stack before closing', async () => {
    state.draftPages = [sourceIds(100, 50), [sourceId(150)]];
    state.documentStatus = url => url.pathname === '/listings/draft' && url.searchParams.get('page') === '2' ? 403 : 200;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /Draft page 2 returned HTTP 403/);
    const logs = main.logs.join('\n');
    assert.match(logs, /HTTP 403 https:\/\/gameflip.com\/listings\/draft\?page=2&limit=50/);
    assert.match(logs, /paused during "Scanning all draft pages" after [\d.]+s; 0 confirmed posts/);
    assert.match(logs, /Page state: .*"draftCopies":1/);
    assert.match(logs, /Error details:\nError: Draft page 2/);
    assert.match(logs, /Closing Chrome for this session/);
    assert.ok(logs.includes(`Autoposter v${require('../package.json').version}`));
    const saved = fs.readFileSync(path.join(main.stateFolder, 'autoposter.log'), 'utf8');
    assert.match(saved, /Draft page 2 returned HTTP 403/);
    assert.equal(state.posts, 0);
});

test('Chrome launch failures are logged and release the run guard', async () => {
    const main = mainProcess({ launchError: new Error('Test Chrome startup failed') });
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
        assert.equal(result.success, false);
        assert.equal(result.postedCount, 0);
        assert.match(result.error, /Test Chrome startup failed/);
    }
    assert.ok(main.logs.some(message => message.includes('paused during "Launching Chrome"')));
    assert.equal(main.closed(), false);
});

test('a Chrome cleanup failure preserves the original missing-editor error', async () => {
    state.blockCopy = true;
    const main = mainProcess({ closeError: new Error('Test cleanup failed') });
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, false);
    assert.match(result.error, /Done control in the draft editor/);
    assert.ok(main.logs.some(message => message.includes('Chrome cleanup: Test cleanup failed')));
    assert.equal(main.logs.some(message => message.includes('GHOST SESSION CLOSED')), false);
    assert.equal(state.posts, 0);
});

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

test('scans 105 drafts before posting a selected ID, verifying publication and deleting only the oldest listing', async () => {
    const first = 0x60000000;
    state.draftPages = [sourceIds(first, 50), sourceIds(first + 50, 50), sourceIds(first + 100, 5)];
    state.pager = 'none';
    state.actionIcon = 'svg';
    state.textOnlyDelete = true;
    state.backgroundDraftTraffic = true;
    let randomCalls = 0;
    const main = mainProcess({ random: () => randomCalls++ === 0 ? 0 : 0.999999 });
    let outcome;
    const run = main.handlers.get('process-drafts')({ sender: {} }, { randomize: true, maintainLimit: true })
        .then(result => { outcome = result; return result; });
    try {
        const deadline = Date.now() + 20000;
        while (!main.logs.some(message => message.includes('Rate Limit Protection'))) {
            assert.equal(outcome, undefined, JSON.stringify({ outcome, logs: main.logs }));
            assert.ok(Date.now() < deadline, 'Did not finish count maintenance');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    } finally {
        await main.handlers.get('stop-drafts')();
        await run;
    }
    assert.equal(outcome.success, true, outcome.error);
    assert.equal(outcome.postedCount, 1);
    assert.deepEqual(state.published, [sourceId(first + 104)]);
    assert.deepEqual(state.deleted, [OLD]);
    assert.deepEqual(state.listings, [sourceId(first + 104), RECENT]);
    const scan = main.logs.findIndex(message => message.includes('Scan complete: 105 unique drafts'));
    assert.ok(scan >= 0 && scan < main.logs.findIndex(message => message.includes('Processing Item 1/105')));
    assert.ok(main.logs.findIndex(message => message.includes('Publication confirmed')) <
        main.logs.findIndex(message => message.includes('Oldest listing deletion verified')));
    const history = JSON.parse(fs.readFileSync(path.join(main.stateFolder, 'posting-history.json')));
    assert.equal(history.submissions.length, 1);
    assert.ok(history.cooldownUntil > Date.now());
});

test('initial Drafts navigation and scanning succeed with persistent background traffic', async () => {
    state.backgroundDraftTraffic = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, JSON.stringify({ result, logs: main.logs }));
    assert.equal(result.postedCount, 1);
    assert.deepEqual(state.published, [NEW]);
});

test('draft readiness uses the clickable parent of a decorative aria-hidden copy icon', async () => {
    state.decorativeCopyIcons = true;
    state.backgroundDraftTraffic = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, JSON.stringify({ result, logs: main.logs }));
    assert.deepEqual(state.published, [NEW]);
});

test('draft scanning waits for delayed batches and loading indicators before ending a short page', async () => {
    page.setDefaultTimeout(5000);
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 5)];
    state.draftRowDelay = 1800;
    state.backgroundDraftTraffic = true;
    const queue = await drafts.scanDrafts(page, () => {});
    assert.equal(queue.length, 55);
    assert.equal(queue.at(-1).key, sourceId(154));
    assert.equal(state.posts, 0);
});

test('a visible decorative loading spinner prevents accepting the first partial draft batch', async () => {
    page.setDefaultTimeout(5000);
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 5)];
    state.draftRowDelay = 1800;
    state.draftLoadingIcon = true;
    const queue = await drafts.scanDrafts(page, () => {});
    assert.equal(queue.length, 55);
    assert.equal(queue.at(-1).key, sourceId(154));
});

for (const problem of ['draftsNeverReady', 'blankDraftPage']) {
    test(`an unfinished draft page (${problem}) cannot be accepted as an empty completed scan`, async () => {
        page.setDefaultTimeout(1500);
        state[problem] = true;
        const logs = [];
        await assert.rejects(drafts.scanDrafts(page, message => logs.push(message)), /draft page .*ready|draft page .*load/i);
        assert.equal(logs.some(message => message.includes('Scan complete')), false);
        assert.equal(state.posts, 0);
    });
}

test('draft scanning waits for a listing-data response before accepting stable partial rows', async () => {
    page.setDefaultTimeout(5000);
    state.draftPages = [sourceIds(100, 50), sourceIds(150, 5)];
    state.draftDataDelay = 1800;
    state.backgroundDraftTraffic = true;
    const queue = await drafts.scanDrafts(page, () => {});
    assert.equal(queue.length, 55);
    assert.equal(queue.at(-1).key, sourceId(154));
    assert.equal(state.posts, 0);
});

test('unfinished listing-data requests cannot turn a partial page into a complete queue', async () => {
    state.drafts = 2;
    state.draftDataNeverReady = true;
    const logs = [];
    await assert.rejects(drafts.scanDrafts(page, message => logs.push(message)), /listing-data requests=1.*\/api\/listings/);
    assert.equal(logs.some(message => message.includes('Scan complete')), false);
    assert.equal(state.posts, 0);
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

for (const kind of ['inline', 'custom', 'iframe']) {
    test(`dismisses a late BE THE FIRST notification ${kind} after posting without resubmitting`, async () => {
        state.postPopup = kind;
        state.popupDelay = 250;
        const main = mainProcess();
        const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
        assert.equal(result.success, true, `${result.error}\n${main.logs.join('\n')}`);
        assert.equal(result.postedCount, 1);
        assert.equal(state.posts, 1);
        assert.equal(state.declines, 1);
        assert.equal(state.accepts || 0, 0);
        assert.deepEqual(state.deleted, []);
        assert.ok(main.logs.some(message => message.includes('popup detected')));
        assert.ok(main.logs.some(message => message.includes('popup dismissal confirmed')));
        assert.match(fs.readFileSync(path.join(main.stateFolder, 'autoposter.log'), 'utf8'), /popup dismissal confirmed/);
    });
}

test('post-publication and On Sale notification prompts do not prevent oldest-listing maintenance', async () => {
    state.postPopup = 'inline';
    state.salePopup = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: true });
    assert.equal(result.success, true, `${result.error}\n${main.logs.join('\n')}`);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.deepEqual(state.deleted, [OLD]);
    assert.equal(state.listings.length, 2);
    assert.equal(state.accepts || 0, 0);
});

test('a notification popup that cannot be dismissed stops with the original submission preserved', async () => {
    state.postPopup = 'inline';
    state.stickyPrompt = true;
    const main = mainProcess();
    const result = await main.handlers.get('process-drafts')({ sender: {} }, { maintainLimit: true });
    assert.equal(result.success, false);
    assert.match(result.error, /notification popup stayed visible/);
    assert.equal(state.posts, 1);
    assert.equal(result.postedCount, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(main.stateFolder, 'posting-history.json'))).submissions.length, 1);
    assert.deepEqual(state.deleted, []);
});

test('a popup that appears while waiting for Done is dismissed with the click delay preserved', async () => {
    setPagePacer(page);
    page.getDefaultTimeout = () => 10000;
    await page.setContent('<button id="done" style="display:none" onclick="window.doneAt=performance.now()">Done</button>');
    const markup = notificationPrompt("window.dismissedAt=performance.now(); document.querySelector('#done').style.display='block'; this.closest('.notification-prompt').remove()");
    await page.evaluate(html => setTimeout(() => document.body.insertAdjacentHTML('beforeend', html), 100), markup);
    await controls.clickControl(page, 'done');
    const timing = await page.evaluate(() => ({ done: window.doneAt, dismissed: window.dismissedAt }));
    assert.ok(timing.done - timing.dismissed >= 1990, JSON.stringify(timing));
});

test('unrelated Not Now controls and hidden notification iframes are left alone', async () => {
    const markup = notificationPrompt("window.incorrectlyDismissed=true");
    await page.setContent('<button onclick="window.incorrectlyDismissed=true">Not Now</button><iframe style="display:none"></iframe>');
    const frame = page.frames().find(frame => frame !== page.mainFrame());
    await frame.setContent(markup);
    assert.equal(await controls.dismissPopup(page), false);
    assert.equal(await page.evaluate(() => Boolean(window.incorrectlyDismissed)), false);
    assert.equal(await frame.evaluate(() => Boolean(window.incorrectlyDismissed)), false);
});

test('the log-folder action opens the saved file independently of posting', async () => {
    const main = mainProcess();
    assert.equal((await main.handlers.get('open-logs')()).success, true);
    assert.deepEqual(main.openedLogs.at(-1), ['folder', main.stateFolder]);
    const file = path.join(main.stateFolder, 'autoposter.log');
    fs.writeFileSync(file, 'Previously saved run');
    assert.equal((await main.handlers.get('open-logs')()).success, true);
    assert.deepEqual(main.openedLogs.at(-1), ['file', file]);
    assert.equal(state.posts, 0);
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
    // Keep the first two reads stale, then expose the listing on a retry.
    // A wall-clock timer could fire before the first read on a busy machine.
    state.indexAfterSaleReads = 3;
    const main = mainProcess({ publicationTimeoutMs: 5000 });
    const result = await main.handlers.get('process-drafts')({ sender: {} }, {});
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.equal(state.saleReads, 3);
    assert.deepEqual(state.deleted, []);
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

test('current On Sale traffic still blocks deletion instead of guessing sorted rows', async () => {
    state.listings.unshift(NEW);
    state.backgroundOnSaleTraffic = true;
    await assert.rejects(controls.deleteOldestListing(page, () => {}, NEW), /current page's requests to settle/);
    assert.deepEqual(state.deleted, []);
    assert.deepEqual(state.listings, [NEW, RECENT, OLD]);
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
    let outcome;
    const run = main.handlers.get('process-drafts')({ sender: {} }, { loop: true })
        .then(result => { outcome = result; return result; });
    try {
        // Publication verification immediately leaves /item/ for On Sale.
        // Observe the actual cooldown rather than that transient address.
        const deadline = Date.now() + 15000;
        while (!main.logs.some(message => message.includes('Rate Limit Protection'))) {
            assert.equal(outcome, undefined, outcome?.error || 'Run ended before its cooldown');
            assert.ok(Date.now() < deadline, 'Expected rate-limit wait before restarting the loop');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    } finally {
        await main.handlers.get('stop-drafts')();
    }
    const result = await run;
    assert.equal(result.success, true, result.error);
    assert.equal(result.postedCount, 1);
    assert.equal(state.posts, 1);
    assert.ok(main.logs.some(message => message.includes('220-second minimum posting interval')));
});

test('the GUI captures the checkbox and locks settings until posting finishes', async () => {
    await page.evaluate(() => {
        window.calls = [];
        window.require = () => ({ ipcRenderer: {
            on: (_, callback) => { window.receiveLog = callback; }, send() {},
            invoke: async (channel, config) => {
                window.calls.push({ channel, config });
                if (channel === 'process-drafts') return new Promise(resolve => window.finishRun = resolve);
                if (channel === 'copy-logs') window.copiedLogs = config;
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
    await page.click('#copyLogs');
    await page.waitForFunction(() => document.querySelector('#copyLogs').textContent === 'Copied');
    assert.match(await page.evaluate(() => window.copiedLogs), /paused after 1 confirmed posts: Deletion not confirmed/);
    await page.click('#openLogs');
    assert.equal(await page.evaluate(() => window.calls.at(-1).channel), 'open-logs');
    await page.evaluate(() => {
        for (let i = 0; i < 2100; i++) window.receiveLog(null, `Message ${i}`);
    });
    await page.waitForFunction(() => document.querySelector('#logContainer').childNodes.length === 2000);
    await page.click('#copyLogs');
    await page.waitForFunction(() => document.querySelector('#copyLogs').textContent === 'Copied');
    assert.match(await page.evaluate(() => window.copiedLogs), /Message 2099/);
});

test('Copy Logs writes and verifies Unicode logs through the main-process clipboard', async () => {
    let copied;
    const main = mainProcess({ clipboard: {
        writeText: async text => { copied = text.replace(/\n/g, '\r\n'); }, readText: async () => copied
    } });
    const result = await main.handlers.get('copy-logs')({}, '✅ Publication confirmed.\n🧹 Oldest listing deletion verified.');
    assert.equal(result.success, true);
    assert.equal(copied, '✅ Publication confirmed.\r\n🧹 Oldest listing deletion verified.');
});

test('Copy Logs reports Windows clipboard errors, silent failures and invalid input', async () => {
    const broken = mainProcess({ clipboard: { async writeText() { throw new Error('Clipboard is busy'); } } });
    const failed = await broken.handlers.get('copy-logs')({}, 'Run diagnostics');
    assert.equal(failed.success, false);
    assert.match(failed.error, /Clipboard is busy/);
    const unchanged = mainProcess({ clipboard: { async writeText() {}, readText: async () => 'old clipboard' } });
    const silentFailure = await unchanged.handlers.get('copy-logs')({}, 'New diagnostics');
    assert.equal(silentFailure.success, false);
    assert.match(silentFailure.error, /did not retain/);
    for (const value of ['', '  ', null, {}]) {
        const invalid = await unchanged.handlers.get('copy-logs')({}, value);
        assert.equal(invalid.success, false);
        assert.match(invalid.error, /no logs to copy/);
    }
});

test('Copy Logs waits for an asynchronous write before reading and reporting success', async () => {
    let finishWrite, copied, reads = 0;
    const main = mainProcess({ clipboard: {
        writeText: text => new Promise(resolve => { finishWrite = () => { copied = text; resolve(); }; }),
        readText: async () => { reads++; return copied; }
    } });
    const pending = main.handlers.get('copy-logs')({}, 'Latest diagnostics');
    assert.equal(reads, 0, 'Must not read the clipboard before the write resolves');
    finishWrite();
    const result = await pending;
    assert.equal(result.success, true, result.error);
    assert.equal(reads, 1);
    const unreadable = mainProcess({ clipboard: {
        async writeText() {}, async readText() { throw new Error('Clipboard access denied'); }
    } });
    const failure = await unreadable.handlers.get('copy-logs')({}, 'Latest diagnostics');
    assert.equal(failure.success, false);
    assert.match(failure.error, /Clipboard access denied/);
});

test('opening a scanned draft uses rendered controls despite pending background traffic', async () => {
    const queue = await drafts.scanDrafts(page, () => {});
    state.backgroundDraftTraffic = true;
    await page.goto('https://gameflip.com/listings/draft?page=1&limit=50', { waitUntil: 'domcontentloaded' });
    await assert.rejects(page.waitForNetworkIdle({ idleTime: 50, timeout: 150 }), /Timed out/);
    assert.equal(await page.$$eval('.tool-duplicate', els => els.length), 1);
    assert.equal(await drafts.openDraft(page, queue[0], () => {}), true);
    const ready = await controls.waitForControl(page, 'done');
    await ready.dispose();
    assert.equal(new URL(page.url()).pathname, `/listings/${NEW}/edit`);
    assert.deepEqual(state.published, []);
});

test('Copy Logs flushes pending messages, prevents duplicate requests and exposes failures in the GUI', async () => {
    await page.evaluate(() => {
        window.copies = [];
        window.require = () => ({ ipcRenderer: {
            on: (_, callback) => { window.receiveLog = callback; }, send() {},
            invoke: (_channel, text) => new Promise((resolve, reject) => {
                window.copies.push(text); window.copyResult = resolve; window.copyError = reject;
            })
        }});
    });
    await page.setContent(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
    await page.evaluate(() => {
        window.receiveLog(null, 'Unflushed failure details');
        document.querySelector('#copyLogs').click();
        document.querySelector('#copyLogs').click();
    });
    assert.equal(await page.$eval('#copyLogs', el => el.disabled), true);
    assert.equal(await page.evaluate(() => window.copies.length), 1);
    assert.match(await page.evaluate(() => window.copies[0]), /Unflushed failure details/);
    await page.evaluate(() => window.copyResult({ success: false, error: 'Clipboard is busy' }));
    await page.waitForFunction(() => document.querySelector('#copyLogs').textContent === 'Copy failed');
    assert.match(await page.$eval('#logContainer', el => el.textContent), /Could not copy logs: Clipboard is busy.*Open Logs Folder/);
    assert.equal(await page.$eval('#copyLogs', el => el.disabled), false);
    await page.click('#copyLogs');
    await page.evaluate(() => window.copyError(new Error('IPC disconnected')));
    await page.waitForFunction(() => document.querySelector('#logContainer').textContent.includes('IPC disconnected'));
    assert.equal(await page.$eval('#copyLogs', el => el.textContent), 'Copy failed');
    await page.click('#copyLogs');
    await page.evaluate(() => window.copyResult({ success: true }));
    await page.waitForFunction(() => document.querySelector('#copyLogs').textContent === 'Copied');
});
