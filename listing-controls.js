const { paceAction, completeAction } = require('./pacing');
const { CONFIRMATION_TIMEOUT_MS } = require('./posting-budget');

const ORIGIN = 'https://gameflip.com';
const ON_SALE = `${ORIGIN}/listings/onsale`;

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
    const power = () => [...document.querySelectorAll('.fa-power-off')].find(el => visible(el) && content(el));
    const clickable = el => el?.closest('button, a, [role="button"]') || el;

    switch (action) {
        case 'sort': return sort();
        case 'sorted': return /created\s*:\s*oldest/i.test(text(sort() || document.createElement('span'))) && sort();
        case 'oldest': {
            const menu = menuFor(sort());
            return visible(menu) && [...menu.querySelectorAll('a, button, [role="menuitem"]')]
                .find(el => visible(el) && /\boldest\b/i.test(text(el)));
        }
        case 'power': return clickable(power());
        case 'trash': {
            const menu = menuFor(power());
            return visible(menu) && clickable([...menu.querySelectorAll('.fa-trash')].find(visible));
        }
        case 'confirm': return buttons.find(el => el.closest('.modal, [role="dialog"]') && /^delete(?: (?:item|listing))?$/i.test(text(el)));
        case 'done': return buttons.find(el => /^done\b/i.test(text(el)));
        case 'list': return buttons.find(el => /^list item$/i.test(text(el)));
        case 'dismiss': return buttons.find(el => el.closest('.modal, [role="dialog"]') && /^(not now|maybe later)$/i.test(text(el)));
    }
}

async function parkPointer(page) {
    const height = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(1, Math.max(1, height - 1));
}

async function clickElement(page, element, { useMouse = false, verify, beforeClick, paced = false } = {}) {
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

async function waitForControl(page, action) {
    try {
        return await page.waitForFunction(findControl, {}, action);
    } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        const labels = { sort: 'Created sort dropdown', sorted: 'Created: Oldest sort result',
            oldest: 'Oldest option in the sort menu', power: 'listing action menu',
            trash: 'Delete action in the listing menu', confirm: 'Delete confirmation',
            done: 'Done control in the draft editor', list: 'List Item control in the preview' };
        throw new Error(`Timed out waiting for ${labels[action] || action} on ${new URL(page.url()).pathname}.`);
    }
}

async function clickControl(page, action, options) {
    await paceAction(page);
    const handle = await waitForControl(page, action);
    try {
        await clickElement(page, handle.asElement(), { ...options, paced: true });
    } finally {
        await handle.dispose();
    }
}

async function settle(page) {
    await page.waitForNetworkIdle({ idleTime: 500 });
}

async function navigate(page, url) {
    await paceAction(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    await parkPointer(page);
    await settle(page);
    completeAction(page);
    return response;
}

function usablePageResponse(response) {
    // Chrome may expose the cache revalidation status even though the rendered
    // document is available. Callers still validate its section and contents.
    return !response || response.ok() || response.status() === 304;
}

async function dismissPopup(page) {
    const initial = await page.evaluateHandle(findControl, 'dismiss');
    const present = Boolean(initial.asElement());
    await initial.dispose();
    if (!present) return;
    await paceAction(page);
    const handle = await page.evaluateHandle(findControl, 'dismiss');
    try {
        if (handle.asElement()) {
            await clickElement(page, handle.asElement(), { paced: true });
            await settle(page);
        }
    } finally {
        await handle.dispose();
    }
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
    await clickControl(page, 'power');
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
        const result = await page.waitForFunction(publicationDOM, { timeout: timeoutMs, polling: 250 }, context);
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
    deleteOldestListing, capturePublication, waitForPublished, settle, usablePageResponse
};
