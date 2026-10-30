const { paceAction, completeAction } = require('./pacing');
const { CONFIRMATION_TIMEOUT_MS } = require('./posting-budget');

const ORIGIN = 'https://gameflip.com';
const ON_SALE = `${ORIGIN}/listings/onsale`;
const networkStates = new WeakMap();

async function trackPageNetwork(page) {
    if (!networkStates.has(page)) networkStates.set(page, (async () => {
        // Raw lifecycle events retain the document/loader identity and are not
        // delayed by Puppeteer's queued request-interception callbacks.
        const session = await page.createCDPSession();
        const state = { pending: new Map(), changed: Date.now() };
        const changed = () => { state.changed = Date.now(); };
        session.on('Network.requestWillBeSent', request => {
            if (request.frameId === state.frameId && request.type !== 'Document' &&
                request.loaderId && request.loaderId !== state.loaderId) return;
            state.pending.set(request.requestId, { loaderId: request.loaderId, type: request.type, url: request.request.url });
            changed();
        });
        const finished = ({ requestId }) => { if (state.pending.delete(requestId)) changed(); };
        session.on('Network.loadingFinished', finished);
        session.on('Network.loadingFailed', finished);
        session.on('Page.frameNavigated', ({ frame }) => {
            if (frame.parentId) return;
            state.frameId = frame.id;
            state.loaderId = frame.loaderId;
            for (const [id, request] of state.pending) if (request.loaderId !== frame.loaderId) state.pending.delete(id);
            changed();
        });
        await Promise.all([session.send('Network.enable'), session.send('Page.enable')]);
        const { frameTree } = await session.send('Page.getFrameTree');
        state.frameId = frameTree.frame.id;
        state.loaderId = frameTree.frame.loaderId;
        page.once('close', () => { state.pending.clear(); session.detach().catch(() => {}); });
        return state;
    })());
    return networkStates.get(page);
}

async function pendingListingRequests(page) {
    const state = await trackPageNetwork(page);
    return [...state.pending.values()].filter(request => {
        if (!['XHR', 'Fetch'].includes(request.type)) return false;
        return /\/(?:listings?|drafts?|graphql|search)(?:\/|$)/i.test(new URL(request.url).pathname);
    }).map(request => {
        const url = new URL(request.url);
        return `${url.origin}${url.pathname}`; // No queries, credentials or headers in diagnostics.
    });
}

function listingId(url) {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== ORIGIN) return null;
        const uuid = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
        const pathId = parsed.pathname.match(new RegExp(`(?:^|/)(${uuid})(?:/|$)`, 'i'))?.[1];
        if (pathId) return pathId.toLowerCase();
        for (const name of ['id', '_id', 'listing', 'listingId', 'listing_id']) {
            const value = parsed.searchParams.get(name);
            if (value && new RegExp(`^${uuid}$`, 'i').test(value)) return value.toLowerCase();
        }
        return null;
    } catch {
        return null;
    }
}

// This function runs inside Chrome. Keep menus scoped to their own controls;
// the profile dropdown and listing navigation must never become action targets.
function findControl(action) {
    const visible = el => el && el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
    const content = el => !el.closest('header, nav, .navbar, [role="navigation"]');
    const text = el => (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent).trim().replace(/\s+/g, ' ');
    const buttons = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')]
        .filter(el => visible(el) && content(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const sort = () => buttons.find(el => el.matches('.dropdown-toggle') && /created\s*:/i.test(text(el)));
    const menuFor = el => el?.closest('.dropdown, .btn-group')?.querySelector('.dropdown-menu');
    const enabled = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const listingMenu = () => {
        if (!/^\/item\//.test(location.pathname)) return null;
        const menuSelector = '.dropdown-menu, [role="menu"]';
        const candidates = [];
        for (const menu of document.querySelectorAll(menuSelector)) {
            if (!content(menu) || menu.closest('.comment, .review, [data-comment-id], [data-review-id]')) continue;
            const entries = [...menu.querySelectorAll('a, button, [role="menuitem"], [role="button"]')]
                .filter(el => el.closest(menuSelector) === menu);
            // Reject account menus even if the site's header markup changes.
            if (entries.some(el => /\b(?:log\s*out|sign\s*out|my\s+profile)\b/i.test(text(el)) ||
                /\/(?:logout|signout|profile|settings)(?:[/?#]|$)/i.test(el.getAttribute('href') || ''))) continue;
            // The Delete entry identifies the seller menu, including while it
            // is hidden. Icons (power, ellipsis, gear, SVG) are not identities.
            const deletes = entries.filter(el => enabled(el) && /^delete(?: (?:item|listing))?$/i.test(text(el) || el.getAttribute('title') || ''));
            if (deletes.length !== 1) continue;
            const toggles = [...new Set([...buttons, ...document.querySelectorAll('.dropdown-toggle, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]')])].filter(el => {
                if (!visible(el) || !content(el) || !enabled(el)) return false;
                if (menu.contains(el)) return false;
                const ids = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.trim().split(/\s+/);
                if (menu.id && ids.includes(menu.id)) return true;
                const group = el.closest('.dropdown, .btn-group');
                return group && group.querySelector(menuSelector) === menu &&
                    el.closest(menuSelector) !== menu;
            });
            if (toggles.length === 1) candidates.push({ toggle: toggles[0], menu, delete: deletes[0] });
        }
        // Never guess between multiple seller/delete menus on a listing page.
        return candidates.length === 1 ? candidates[0] : null;
    };

    switch (action) {
        case 'sort': return sort();
        case 'sorted': return /created\s*:\s*oldest/i.test(text(sort() || document.createElement('span'))) && sort();
        case 'oldest': {
            const menu = menuFor(sort());
            return visible(menu) && [...menu.querySelectorAll('a, button, [role="menuitem"]')]
                .find(el => visible(el) && /\boldest\b/i.test(text(el)));
        }
        case 'listing-actions': return listingMenu()?.toggle || null;
        case 'trash': {
            const target = listingMenu();
            return target && visible(target.menu) && visible(target.delete) && target.delete;
        }
        case 'confirm': return buttons.find(el => el.closest('.modal, [role="dialog"]') && /^delete(?: (?:item|listing))?$/i.test(text(el)));
        case 'done': return buttons.find(el => /^done\b/i.test(text(el)));
        case 'list': return buttons.find(el => /^list item$/i.test(text(el)));
        case 'dismiss': {
            // Push widgets sometimes implement their decline button as a div.
            const candidates = [...buttons, ...[...document.querySelectorAll('div, span')].reverse()
                .filter(el => visible(el) && content(el) && el.getAttribute('aria-disabled') !== 'true')];
            return candidates.find(el => {
                if (!/^(?:not\s*now|maybe\s+later)$/i.test(text(el))) return false;
                if (el.closest('.modal, dialog, [role="dialog"], [aria-modal="true"]')) return true;
                // Some notification widgets use ordinary divs rather than dialogs.
                for (let container = el.parentElement, depth = 0; container && container !== document.body && depth < 8;
                    container = container.parentElement, depth++) {
                    if (/\bbe the first\b|receive instant order updates|account alerts and special discounts/i.test(container.innerText || '')) return true;
                }
                return false;
            });
        }
    }
}

async function parkPointer(page) {
    const height = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(1, Math.max(1, height - 1));
}

async function clickElement(page, element, { useMouse = false, verify, beforeClick, paced = false } = {}) {
    await trackPageNetwork(page);
    if (!paced) await paceAction(page);
    if (verify) await verify();
    await parkPointer(page);
    const handle = await element.evaluateHandle(el => el.closest('a, button, input, [role="button"]') ||
        el.querySelector('a, button, input, [role="button"]') || el);
    try {
        if (!await handle.evaluate(el => el.isConnected && !el.disabled && el.getAttribute('aria-disabled') !== 'true')) {
            throw new Error('The action control changed or became disabled before it could be clicked.');
        }
        await handle.evaluate(el => {
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const link = el.closest('a');
            if (link) link.target = '_self';
        });
        if (beforeClick) await beforeClick();
        if (useMouse) await handle.asElement().click();
        else await handle.evaluate(el => el.click());
    } finally {
        await handle.dispose();
        completeAction(page);
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function changingContext(error) {
    for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
        if (/execution context was destroyed|cannot find context|detached frame|frame (?:was|got) detached|JSHandles can be evaluated only in the context/i.test(current.message || '')) return true;
    }
    return false;
}

async function waitWithPopups(page, predicate, args, timeoutMs) {
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    do {
        try {
            await dismissPopup(page);
            const result = await page.evaluateHandle(predicate, ...args);
            if (await result.evaluate(value => Boolean(value))) return result;
            await result.dispose();
        } catch (error) {
            if (!changingContext(error)) throw error;
        }
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    const error = new Error(`Waiting failed: ${timeoutMs}ms exceeded`);
    error.name = 'TimeoutError';
    throw error;
}

async function waitForControl(page, action, timeoutMs = page.getDefaultTimeout()) {
    try {
        return await waitWithPopups(page, findControl, [action], timeoutMs);
    } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        const labels = { sort: 'Created sort dropdown', sorted: 'Created: Oldest sort result',
            oldest: 'Oldest option in the sort menu', 'listing-actions': 'unambiguous listing action menu with a Delete entry',
            trash: 'Delete action in the listing menu', confirm: 'Delete confirmation',
            done: 'Done control in the draft editor', list: 'List Item control in the preview' };
        throw new Error(`Timed out waiting for ${labels[action] || action} on ${new URL(page.url()).pathname}.`);
    }
}

async function clickControl(page, action, options) {
    const timeout = page.getDefaultTimeout();
    const deadline = timeout ? Date.now() + timeout : Infinity;
    do {
        const ready = await waitForControl(page, action, Math.max(1, deadline - Date.now()));
        await ready.dispose();
        await paceAction(page);
        if (await dismissPopup(page)) continue;
        // A popup or the action pause may have caused a render. Resolve again.
        const handle = await page.evaluateHandle(findControl, action);
        try {
            if (handle.asElement()) {
                await clickElement(page, handle.asElement(), { ...options, paced: true });
                return;
            }
        } finally { await handle.dispose(); }
    } while (Date.now() < deadline);
    throw new Error(`The ${action} control kept changing while popups were being dismissed; posting paused.`);
}

async function popupControl(page) {
    if (page.isClosed()) throw new Error('Browser page closed while checking notification popups.');
    for (const frame of page.frames()) {
        const childFrame = frame !== page.mainFrame();
        if (childFrame && (frame.detached || !page.frames().includes(frame))) continue;
        try {
            if (childFrame) {
                const element = await frame.frameElement();
                let visible;
                try { visible = element && await element.evaluate(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); }
                finally { await element?.dispose(); }
                if (!visible) continue;
            }
            const handle = await frame.evaluateHandle(findControl, 'dismiss');
            if (handle.asElement()) return { frame, handle };
            await handle.dispose();
        } catch (error) {
            if (page.isClosed()) throw error;
            // The frame list and Chrome's DOM-owner lookup are not atomic.
            // Ad/notification iframes can disappear before Puppeteer reports
            // their detach event. Only this missing-child-owner error is benign.
            if (childFrame && (frame.detached || !page.frames().includes(frame) || missingFrameOwner(error))) continue;
            if (!changingContext(error)) throw error;
        }
    }
    return null;
}

function missingFrameOwner(error) {
    for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
        if (/DOM\.getFrameOwner.*(?:Frame with the given id was not found|No frame for given id)/i.test(current.message || '')) return true;
    }
    return false;
}

async function settle(page) {
    const state = await trackPageNetwork(page);
    await dismissPopup(page);
    const timeout = page.getDefaultTimeout();
    const started = Date.now();
    const deadline = timeout ? started + timeout : Infinity;
    while (state.pending.size || Date.now() - Math.max(started, state.changed) < 500) {
        if (page.isClosed()) throw new Error('Browser page closed while waiting for the current page to settle.');
        if (Date.now() >= deadline) {
            const details = [...state.pending.values()].filter(request => /^https?:/.test(request.url)).slice(0, 3).map(request => {
                const url = new URL(request.url);
                return `${request.type} ${url.origin}${url.pathname}`;
            });
            throw new Error(`Timed out waiting for the current page's requests to settle (${state.pending.size} pending).` +
                (details.length ? ` Pending: ${details.join(', ')}` : ''));
        }
        await sleep(50);
    }
    await dismissPopup(page);
}

async function navigate(page, url, { waitForIdle = true } = {}) {
    await trackPageNetwork(page);
    await paceAction(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    await parkPointer(page);
    completeAction(page);
    if (waitForIdle) await settle(page);
    else await dismissPopup(page);
    completeAction(page);
    return response;
}

function usablePageResponse(response) {
    // Chrome may expose the cache revalidation status even though the rendered
    // document is available. Callers still validate its section and contents.
    return !response || response.ok() || response.status() === 304;
}

async function dismissPopup(page) {
    let dismissed = false;
    for (let attempt = 0; attempt <= 3; attempt++) {
        const initial = await popupControl(page);
        if (!initial) return dismissed;
        await initial.handle.dispose();
        if (attempt === 3) throw new Error('Notification/promotion popups kept reappearing; posting paused.');
        page.emit('automation-popup', 'Notification/promotion popup detected; selecting Not Now/Maybe Later...');
        await paceAction(page);
        const current = await popupControl(page);
        if (!current) return dismissed;
        const { frame, handle } = current;
        try {
            const beforeUrl = frame.url();
            const leftFrame = () => !page.isClosed() &&
                (frame.detached || !page.frames().includes(frame) || frame.url() !== beforeUrl);
            try {
                await clickElement(page, handle.asElement(), { paced: true });
                const deadline = Date.now() + 5000;
                while (!leftFrame()) {
                    if (await handle.evaluate(el => !el.isConnected || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden')) break;
                    if (Date.now() >= deadline) throw new Error('Not Now/Maybe Later was clicked, but the notification popup stayed visible; posting paused.');
                    await sleep(100);
                }
            } catch (error) {
                // An out-of-process iframe may remove itself during its click.
                // Allow its detach event to arrive; a closed main page is an error.
                if (frame !== page.mainFrame() && !page.isClosed() && /target closed/i.test(error.message)) await sleep(50);
                if (!changingContext(error) && !leftFrame()) throw error;
            }
            dismissed = true;
            page.emit('automation-popup', '✅ Notification/promotion popup dismissal confirmed.');
        } finally { await handle.dispose(); }
    }
    return dismissed;
}

async function activeListingLinks(page) {
    const urls = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
        .filter(el => el.getClientRects().length && !el.closest('header, nav, .navbar, [role="navigation"], .dropdown-menu'))
        .map(el => el.href));
    return [...new Set(urls.filter(url => listingId(url) && /\/(?:item|listings?)\//.test(new URL(url).pathname)))];
}

async function sortOldest(page) {
    const sort = await waitForControl(page, 'sort');
    const alreadySorted = await sort.evaluate(el => /created\s*:\s*oldest/i.test(el.textContent));
    await sort.dispose();
    if (!alreadySorted) {
        await clickControl(page, 'sort');
        await clickControl(page, 'oldest');
        const sorted = await waitForControl(page, 'sorted');
        await sorted.dispose();
    }
    // Wait for the actual listing refresh, not just a changed dropdown label.
    await settle(page);
}

async function requireOldestSort(page) {
    try {
        await sortOldest(page);
    } catch (error) {
        throw new Error(`Could not verify Created: Oldest on On Sale; posting paused. ${error.message}`);
    }
}

async function deleteOldestListing(page, log, publishedId) {
    if (!publishedId) throw new Error('Published listing identity is missing; nothing was deleted.');
    log('🧹 Maintaining count: locating the oldest active listing...');
    await navigate(page, ON_SALE);
    if (new URL(page.url()).pathname !== '/listings/onsale') throw new Error('On Sale page unavailable; deletion stopped.');
    await requireOldestSort(page);
    const [oldest] = await activeListingLinks(page);
    if (!oldest) throw new Error('No identifiable active listing found; nothing was deleted.');
    const oldestId = listingId(oldest);
    if (oldestId === publishedId) throw new Error('Only the newly posted listing was found; it will not be deleted.');

    await navigate(page, oldest);
    if (listingId(page.url()) !== oldestId) throw new Error('Unexpected listing opened; deletion stopped.');
    await dismissPopup(page);
    await clickControl(page, 'listing-actions');
    await clickControl(page, 'trash');
    await clickControl(page, 'confirm');
    await settle(page);

    // A confirmation click is not proof the server accepted the deletion.
    await navigate(page, ON_SALE);
    await requireOldestSort(page);
    if ((await activeListingLinks(page)).some(url => listingId(url) === oldestId)) {
        throw new Error('The oldest listing is still On Sale; posting paused to preserve the listing count.');
    }
    log('✅ Oldest listing deletion verified.');
}

// Runs in Chrome for both the pre-click snapshot and publication observation.
function publicationDOM(context, control) {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const text = el => (el.innerText || el.value || el.textContent).trim().replace(/\s+/g, ' ').slice(0, 1000);
    const receipts = [...document.querySelectorAll('.alert-success, [role="status"], [role="alert"], .modal, [role="dialog"], .toast')]
        .filter(visible).filter(el => {
            const value = text(el);
            return /\b(?:successfully\s+(?:listed|published)|(?:item|listing)\b.{0,80}\b(?:listed|published|now live|on sale))\b/i.test(value) &&
                !/\b(?:not\s+(?:listed|published|live|on sale)|failed|unable|cannot|error)\b/i.test(value);
        }).map(el => ({ text: text(el), links: [...el.querySelectorAll('a[href]')].map(a => a.href) }));
    if (context.capture) {
        const form = control?.closest('form');
        const root = form || document;
        const selectors = '[data-listing-id], input[name="listing_id"], input[name="listingId"], input[name="_id"]' +
            (form ? ', input[name="id"]' : '');
        return { before: receipts.map(receipt => receipt.text), candidates: [
            form?.action, form?.getAttribute('data-listing-id'),
            ...[...root.querySelectorAll(selectors)].map(el => el.getAttribute('data-listing-id') || el.value)
        ].filter(Boolean) };
    }
    const fresh = receipts.find(receipt => !(context.before || []).includes(receipt.text));
    if (fresh) return { kind: 'receipt', links: fresh.links };
    if (/^\/item\//.test(location.pathname) && !/\/(edit|preview|sell)(?:\/|$)/.test(location.pathname)) {
        return { kind: 'item', url: location.href };
    }
    if (location.pathname.replace(/\/$/, '') === '/listings/onsale') return { kind: 'onsale' };
    const rejected = [...document.querySelectorAll('.alert-danger, .alert-error, [role="alert"]')]
        .some(el => visible(el) && /\b(?:error|rejected|failed|unable|limit reached)\b/i.test(text(el)));
    return rejected ? { kind: 'error' } : false;
}

async function capturePublication(page) {
    const control = await waitForControl(page, 'list');
    let snapshot;
    try {
        snapshot = await page.evaluate(publicationDOM, { capture: true }, control.asElement());
    } finally {
        await control.dispose();
    }
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    const ids = [...new Set(snapshot.candidates.map(value => uuid.test(value) ? value.toLowerCase() : listingId(value)).filter(Boolean))];
    return { id: listingId(page.url()) || (ids.length === 1 ? ids[0] : null), before: snapshot.before };
}

async function findPostedOnSale(page, id, deadline) {
    const seen = new Set();
    for (let number = 1; ; number++) {
        const response = await navigate(page, `${ON_SALE}?page=${number}&limit=50`);
        if (!usablePageResponse(response) || new URL(page.url()).pathname.replace(/\/$/, '') !== '/listings/onsale') return false;
        const ids = [...new Set((await activeListingLinks(page)).map(listingId))];
        if (ids.includes(id)) return true;
        const signature = JSON.stringify(ids);
        if (ids.length < 50 || seen.has(signature) || Date.now() >= deadline) return false;
        seen.add(signature);
    }
}

async function waitForPublished(page, context, {
    timeoutMs = CONFIRMATION_TIMEOUT_MS, retryDelayMs = 5000,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}
} = {}) {
    if (typeof context === 'string' || !context) context = { id: context, before: [] };
    const deadline = Date.now() + timeoutMs;
    let state;
    try {
        const result = await waitWithPopups(page, publicationDOM, [context], timeoutMs);
        try { state = await result.jsonValue(); } finally { await result.dispose(); }
    } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        state = { kind: 'timeout' };
    }
    const receiptIds = (state.links || []).map(listingId).filter(Boolean);
    const id = listingId(state.url) || (new Set(receiptIds).size === 1 ? receiptIds[0] : null) || context.id;
    if (!id) {
        if (state.kind === 'receipt') return null; // Explicit success; count it, but do not guess an ID for deletion.
        throw new Error('On Sale/publication was reached without an identifiable copied listing ID. The submission may have posted; check Gameflip before restarting. No deletion was attempted.');
    }
    log('Verifying the submitted listing in On Sale (without submitting it again)...');
    do {
        if (await findPostedOnSale(page, id, Math.max(deadline, Date.now() + 10000))) return id;
        if (state.kind === 'error' || Date.now() >= deadline) break;
        await sleep(Math.min(retryDelayMs, deadline - Date.now()));
    } while (Date.now() < deadline);
    throw new Error('The submission was recorded, but the listing could not be verified in On Sale. It may have posted; check Gameflip before restarting. No retry or deletion was attempted.');
}

module.exports = {
    listingId, findControl, clickElement, clickControl, waitForControl, navigate, dismissPopup,
    deleteOldestListing, capturePublication, waitForPublished, settle, usablePageResponse, pendingListingRequests, changingContext
};
