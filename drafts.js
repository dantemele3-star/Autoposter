const { clickElement, navigate, dismissPopup, usablePageResponse } = require('./listing-controls');
const { paceAction } = require('./pacing');

const PAGE_SIZE = 50;
const draftUrl = page => `https://gameflip.com/listings/draft?page=${page}&limit=${PAGE_SIZE}`;

// Runs inside Chrome. Identify the source draft, not its changing row position.
function draftRows(button = null) {
    const uuid = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i;
    const buttons = button ? [button] : [...document.querySelectorAll('.tool-duplicate')];
    return buttons.map((el, index) => {
        const link = el.closest('a[href]') || el.querySelector('a[href]');
        const href = link?.getAttribute('href');
        let id = (href || '').match(uuid)?.[0];
        for (let row = el, depth = 0; !id && row && depth < 8; row = row.parentElement, depth++) {
            if (row === document.body || row.querySelectorAll('.tool-duplicate').length > 1) break;
            id = [row.getAttribute('data-listing-id'), row.getAttribute('data-id'),
                ...[...row.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))]
                .filter(Boolean).map(value => value.match(uuid)?.[0]).find(Boolean);
        }
        let copyUrl = null;
        if (href && !/^(?:#|javascript:)/i.test(href)) {
            const url = new URL(href, location.href);
            if (url.origin === 'https://gameflip.com') copyUrl = url.href;
        }
        return { key: id?.toLowerCase() || copyUrl, index };
    });
}

function pageBoundary(ordinal) {
    const pager = '[class*="pagination" i], .pager, [class*="paginator" i], nav[aria-label*="page" i]';
    const controls = [...document.querySelectorAll('a, button, [role="button"]')]
        .filter(el => el.getClientRects().length && !el.closest('header, .navbar, .dropdown-menu'));
    const disabled = el => el.disabled || el.closest('.disabled, [aria-disabled="true"], [disabled]');
    const next = controls.filter(el => el.rel === 'next' ||
        /\bnext\b|^(?:›|»|>|→)$/i.test([el.textContent, el.getAttribute('aria-label'), el.title].filter(Boolean).join(' ').trim()));
    const numbered = controls.filter(el => el.closest(pager) && /^\d+$/.test(el.textContent.trim()));
    const active = numbered.find(el => el.closest('.active, .current, [aria-current="page"]'));
    const current = active ? Number(active.textContent.trim()) : ordinal;
    const higher = numbered.some(el => !disabled(el) && Number(el.textContent.trim()) > current);
    const hasNext = next.some(el => !disabled(el)) || higher;
    const confirmedNext = next.filter(el => el.closest(pager) || el.rel === 'next' ||
        /next\s+page/i.test(el.getAttribute('aria-label') || '') ||
        (el.href && new URL(el.href).pathname === '/listings/draft'));
    return {
        hasNext,
        atEnd: !hasNext && confirmedNext.length > 0 && confirmedNext.every(disabled)
    };
}

async function snapshot(page) {
    const rows = await page.evaluate(draftRows);
    if (rows.some(row => !row.key)) {
        throw new Error('A draft has no identifiable listing ID or copy link. Posting paused rather than using an uncertain row index.');
    }
    if (new Set(rows.map(row => row.key)).size !== rows.length) {
        throw new Error('Multiple draft rows share the same identity. Cannot safely index this page; posting paused.');
    }
    return { rows, signature: JSON.stringify(rows.map(row => row.key)) };
}

async function loadPage(page, ordinal, log, navigationOptions) {
    let response = await navigate(page, draftUrl(ordinal), navigationOptions);
    // A 304 with no usable cached body must not turn a full queue into a
    // seemingly complete partial scan. Confirm an empty page without cache.
    const hasDraftControls = () => page.evaluate(() => Boolean(document.querySelector('.tool-duplicate')));
    if (response?.status() === 304 && !await hasDraftControls()) {
        log(`Draft page ${ordinal}: cached response has no draft controls; checking once without cache...`);
        await page.setCacheEnabled(false);
        try { response = await navigate(page, draftUrl(ordinal), navigationOptions); }
        finally { await page.setCacheEnabled(true); }
        if (response?.status() === 304 && !await hasDraftControls()) {
            throw new Error(`Draft page ${ordinal} still has no usable cached draft content; posting paused.`);
        }
    }
    if (!usablePageResponse(response)) throw new Error(`Draft page ${ordinal} returned HTTP ${response.status()}; posting paused.`);
    if (new URL(page.url()).pathname.replace(/\/$/, '') !== '/listings/draft') {
        throw new Error('Gameflip left the Drafts section during scanning; posting paused.');
    }
    return snapshot(page);
}

async function walkPages(page, visit, log, stopped) {
    const seen = new Set();
    for (let ordinal = 1; !stopped(); ordinal++) {
        log(`Scanning page ${ordinal}...`);
        const { rows, signature } = await loadPage(page, ordinal, log);
        if (seen.has(signature)) {
            throw new Error(`Draft page ${ordinal} repeated an earlier page. Cannot confirm a complete scan; posting paused.`);
        }
        seen.add(signature);
        log(`Found ${rows.length} drafts on page ${ordinal}.`);
        const found = await visit(rows, ordinal);
        if (found) return found;
        const boundary = await page.evaluate(pageBoundary, ordinal);
        log(`Page ${ordinal} pagination: next=${boundary.hasNext}, end=${boundary.atEnd}.`);
        if (!rows.length || boundary.atEnd || (!boundary.hasNext && rows.length < PAGE_SIZE)) {
            log(`Last draft page confirmed: ${ordinal}${!rows.length ? ' (empty)' : ''}.`);
            return null;
        }
        // A full page must be followed even when Gameflip's pager markup is
        // unrecognized. page=N&limit=50 is the site's actual pagination URL.
    }
    return null;
}

async function scanDrafts(page, log, stopped = () => false) {
    const drafts = new Map();
    await walkPages(page, (rows, ordinal) => {
        let added = 0;
        for (const row of rows) if (!drafts.has(row.key)) {
            drafts.set(row.key, { ...row, page: ordinal });
            added++;
        }
        if (rows.length && !added) throw new Error(`Draft page ${ordinal} contained only already scanned drafts; posting paused.`);
    }, log, stopped);
    if (stopped()) return [];
    log(`✅ Scan complete: ${drafts.size} unique drafts. Posting can now begin.`);
    return [...drafts.values()];
}

async function openDraft(page, draft, log, stopped = () => false) {
    // This page was already scanned in full. Background traffic can keep Chrome
    // permanently non-idle even with all draft controls rendered. DOMContentLoaded
    // is enough here: loadPage validates the response/section/identities, and we
    // recheck the selected ID below and immediately before the actual click.
    log(`Reopening draft page ${draft.page}; checking the selected source ID in the rendered controls...`);
    let current = (await loadPage(page, draft.page, log, { waitForIdle: false })).rows.find(row => row.key === draft.key);
    if (!current) {
        log(`Draft moved from scanned page ${draft.page}; locating it by listing ID...`);
        current = await walkPages(page, rows => rows.find(row => row.key === draft.key), log, stopped);
    }
    if (stopped()) return false;
    if (!current) throw new Error(`The draft from scanned page ${draft.page}, row ${draft.index + 1} is no longer available. No other draft was selected.`);
    await dismissPopup(page);
    await paceAction(page);
    current = (await snapshot(page)).rows.find(row => row.key === draft.key);
    if (!current) throw new Error('The selected draft moved while the page was settling. No other draft was selected.');
    const buttons = await page.$$('.tool-duplicate');
    try {
        const button = buttons[current.index];
        if (!button || (await page.evaluate(draftRows, button))[0].key !== draft.key) {
            throw new Error('The selected draft changed before it could be opened.');
        }
        await clickElement(page, button, { useMouse: true, paced: true, verify: async () => {
            if ((await page.evaluate(draftRows, button))[0].key !== draft.key) {
                throw new Error('The selected draft changed during the action pause.');
            }
        } });
    } finally {
        await Promise.all(buttons.map(button => button.dispose()));
    }
    // The caller waits for the editor's Done control. Background requests on
    // the old page are not a useful readiness signal for that transition.
    await dismissPopup(page);
    return true;
}

module.exports = { scanDrafts, openDraft };
