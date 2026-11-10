const { openDraft } = require('./drafts');
const { advanceEditor, dismissPopup, waitForControl, changingContext } = require('./listing-controls');

// Read only bounded UI signals. Do not log form values, account text, or URL queries.
async function preparationState(page) {
    return page.evaluate(() => {
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' &&
            !el.closest('[aria-hidden="true"]');
        const buttons = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')]
            .filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
                !el.closest('header, nav, .navbar, [role="navigation"]'));
        const text = el => (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        const done = buttons.some(el => /^done\b/i.test(text(el)));
        const listItem = buttons.some(el => /^list item$/i.test(text(el)));
        const pathname = location.pathname;
        const editor = /^\/sell_item(?:\/|$)|^\/listings?\/(?:[^/]+\/)?(?:edit|preview)(?:\/|$)/.test(pathname);
        let kind = 'other';
        if (location.origin === 'https://gameflip.com') {
            const login = /^\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(pathname) ||
                [...document.querySelectorAll('input[type="password"]')].some(visible);
            const challenge = /verify (?:that )?you are human|checking your browser|just a moment/i.test(document.title) ||
                [...document.querySelectorAll('iframe[src]')].some(el => visible(el) &&
                    /captcha|challenges\.cloudflare/i.test(el.src) && el.getBoundingClientRect().height > 100);
            if (login) kind = 'login';
            else if (challenge) kind = 'challenge';
            else if (editor && listItem) kind = 'preview';
            else if (editor) kind = 'editor';
            else if (/^\/listings\/draft\/?$/.test(pathname)) kind = 'drafts';
            else if (/^\/listings\/onsale\/?$/.test(pathname)) kind = 'onsale';
        }
        return { kind, pathname, done, listItem,
            draftCopies: [...document.querySelectorAll('.tool-duplicate')].filter(visible).length,
            dialogs: [...document.querySelectorAll('.modal, dialog, [role="dialog"]')].filter(visible).length };
    });
}

function recoverablePreparationError(error) {
    return changingContext(error) || error.name === 'TimeoutError' ||
        /^(?:Timed out waiting for|Navigation timeout|Waiting failed:|Done was ignored twice|The action control changed)/i.test(error.message) ||
        /^Draft page \d+ (?:did not become ready|returned HTTP (?:500|502|503|504)\b)/.test(error.message) ||
        /net::ERR_(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|INTERNET_DISCONNECTED)/.test(error.message);
}

async function recoveryWait(ms, stopped) {
    const deadline = Date.now() + ms;
    while (!stopped() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
}

// This function cannot submit or delete. It only prepares a preview for the
// caller, which reserves the posting budget immediately before List Item.
async function prepareDraft(page, item, { log = () => {}, step = () => {}, stopped = () => false,
    retryDelays = [5000, 10000], wait = recoveryWait } = {}) {
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (stopped()) return { status: 'stopped' };
        let opened = false;
        try {
            step('Opening the selected draft copy');
            if (!await openDraft(page, item, log, stopped)) return { status: 'stopped' };
            opened = true;
            if (stopped()) return { status: 'stopped' };
            await dismissPopup(page);
            step('Waiting for Done in the draft editor');
            await advanceEditor(page, { log });
            if (stopped()) return { status: 'stopped' };
            await dismissPopup(page);
            step('Waiting for List Item in the listing preview');
            const ready = await waitForControl(page, 'list');
            await ready.dispose();
            const state = await preparationState(page);
            if (stopped()) return { status: 'stopped' };
            if (state.kind !== 'preview') throw new Error(`The expected listing preview was not reached (page=${state.kind}, path=${state.pathname}); no submission was attempted.`);
            return { status: 'ready' };
        } catch (error) {
            if (stopped()) return { status: 'stopped' };
            if (page.isClosed() || !recoverablePreparationError(error)) throw error;
            let state;
            try { state = await preparationState(page); }
            catch (inspectionError) {
                if (!changingContext(inspectionError)) throw inspectionError;
                state = { kind: 'changing' };
            }
            if (stopped()) return { status: 'stopped' };
            log(`Draft preparation failed before submission: ${error.message}`);
            log(`Recovery page state: ${JSON.stringify(state)}`);
            if (state.kind === 'login' || state.kind === 'challenge') {
                throw new Error(`Gameflip requires ${state.kind === 'login' ? 'sign-in' : 'a manual browser check'}; posting paused without retrying or submitting.`, { cause: error });
            }
            if (opened && state.kind === 'preview') {
                log('The listing preview finished loading after the wait; continuing without making another copy.');
                return { status: 'ready' };
            }
            if (!['drafts', 'editor', 'changing', ...(!opened ? ['onsale'] : [])].includes(state.kind)) {
                throw new Error(`Cannot safely recover draft preparation from page=${state.kind}; no submission was attempted.`, { cause: error });
            }
            if (attempt === retryDelays.length) {
                log(`Skipping source draft ${item.key} after ${attempt + 1} preparation attempts; no submission was recorded.`);
                return { status: 'skipped', error };
            }
            step('Recovering the draft before submission');
            log(`Retrying the same source draft ${item.key} by ID in ${retryDelays[attempt] / 1000}s (preparation attempt ${attempt + 2}/${retryDelays.length + 1}).`);
            await wait(retryDelays[attempt], stopped);
        }
    }
}

module.exports = { prepareDraft, preparationState, recoverablePreparationError };
