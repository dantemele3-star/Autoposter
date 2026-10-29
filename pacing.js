const MIN_CLICK_DELAY_MS = 2000;
const pacers = new WeakMap();

class ActionPacer {
    constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
        this.now = now;
        this.sleep = sleep;
        this.lastAction = null;
    }

    async wait() {
        const elapsed = this.lastAction === null ? 0 : this.now() - this.lastAction;
        const remaining = Math.max(0, MIN_CLICK_DELAY_MS - elapsed);
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

module.exports = { ActionPacer, setPagePacer, paceAction, completeAction, MIN_CLICK_DELAY_MS };
