const MIN_CLICK_DELAY_MS = 2000;
const MAX_CLICK_DELAY_MS = 4000;
const pacers = new WeakMap();

class ActionPacer {
    constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
        this.now = now;
        this.sleep = sleep;
        this.random = random;
        this.lastAction = null;
    }

    async wait() {
        const elapsed = this.lastAction === null ? 0 : this.now() - this.lastAction;
        const delay = MIN_CLICK_DELAY_MS + Math.floor(this.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS + 1));
        const remaining = Math.max(0, delay - elapsed);
        if (remaining) await this.sleep(remaining);
        this.lastAction = this.now();
    }

    mark() {
        this.lastAction = this.now();
    }
}

function setPagePacer(page, pacer = new ActionPacer()) {
    pacers.set(page, pacer);
}

async function paceAction(page) {
    if (!pacers.has(page)) setPagePacer(page);
    await pacers.get(page).wait();
}

function completeAction(page) {
    pacers.get(page)?.mark();
}

module.exports = { ActionPacer, setPagePacer, paceAction, completeAction, MIN_CLICK_DELAY_MS, MAX_CLICK_DELAY_MS };
