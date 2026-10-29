const ORIGIN = 'https://gameflip.com';
const ON_SALE = `${ORIGIN}/listings/onsale`;

function listingId(url) {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== ORIGIN) return null;
        return parsed.pathname.match(/(?:^|\/)([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?:\/|$)/i)?.[1]?.toLowerCase() || null;
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
    const text = el => el.textContent.trim().replace(/\s+/g, ' ');
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
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
        case 'done': return buttons.find(el => /^done$/i.test(text(el)));
        case 'list': return buttons.find(el => /^list item$/i.test(text(el)));
        case 'dismiss': return buttons.find(el => el.closest('.modal, [role="dialog"]') && /^(not now|maybe later)$/i.test(text(el)));
    }
}

async function parkPointer(page) {
    const height = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(1, Math.max(1, height - 1));
}

async function clickElement(page, element) {
    await parkPointer(page);
    await element.evaluate(el => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const link = el.closest('a');
        if (link) link.target = '_self';
        el.click();
    });
}

async function clickControl(page, action) {
    const handle = await page.waitForFunction(findControl, {}, action);
    try {
        await clickElement(page, handle.asElement());
    } finally {
        await handle.dispose();
    }
}

async function settle(page) {
    await page.waitForNetworkIdle({ idleTime: 500 });
}

async function navigate(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await parkPointer(page);
    await settle(page);
}

async function dismissPopup(page) {
    const handle = await page.evaluateHandle(findControl, 'dismiss');
    try {
        if (handle.asElement()) await clickElement(page, handle.asElement());
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
    const sort = await page.waitForFunction(findControl, {}, 'sort');
    const alreadySorted = await sort.evaluate(el => /created\s*:\s*oldest/i.test(el.textContent));
    await sort.dispose();
    if (!alreadySorted) {
        await clickControl(page, 'sort');
        await clickControl(page, 'oldest');
        const sorted = await page.waitForFunction(findControl, {}, 'sorted');
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

async function waitForPublished(page, draftId) {
    const result = await page.waitForFunction(expectedId => {
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        if ([...document.querySelectorAll('button')].some(el => visible(el) && /^list item$/i.test(el.textContent.trim()))) return false;
        const itemPage = /^\/item\//.test(location.pathname) && !/\/(edit|preview|sell)(?:\/|$)/.test(location.pathname);
        const onSale = location.pathname === '/listings/onsale' && expectedId &&
            [...document.querySelectorAll('a[href]')].some(el => visible(el) && el.href.includes(expectedId));
        const success = [...document.querySelectorAll('.alert-success, [role="status"]')]
            .some(el => visible(el) && /(?:listed|published|now live|on sale)/i.test(el.textContent));
        return itemPage || onSale || success;
    }, {}, draftId);
    await result.dispose();
    await settle(page);
    const id = listingId(page.url()) || draftId;
    if (!id) throw new Error('Could not identify the published listing; posting paused.');
    return id;
}

module.exports = {
    listingId, findControl, clickElement, clickControl, navigate, dismissPopup,
    deleteOldestListing, waitForPublished, parkPointer, settle
};
