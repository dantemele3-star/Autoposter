const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;

function safeUrl(value) {
    try {
        const url = new URL(value);
        const query = new URLSearchParams();
        for (const name of ['page', 'limit']) {
            if (/^\d+$/.test(url.searchParams.get(name) || '')) query.set(name, url.searchParams.get(name));
        }
        const hidden = [...url.searchParams.keys()].some(name => !query.has(name));
        return `${url.origin}${url.pathname}${query.size ? `?${query}` : ''}${hidden ? (query.size ? '&' : '?') + '[hidden]' : ''}`;
    } catch {
        return '(unavailable)';
    }
}

function redact(message) {
    return String(message)
        .replace(/https?:\/\/[^\s<>"')]+/gi, safeUrl)
        .replace(/\bAIza[\w-]{35}\b/g, '[key hidden]')
        .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [hidden]')
        .replace(/\b((?:api[_-]?key|api[_-]?secret|access[_-]?token|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[hidden]');
}

class RunLog {
    constructor(file, send) {
        this.file = file;
        this.send = send;
        this.notes = [];
        this.listeners = [];
        this.step('Initializing');
    }

    write(message) {
        const clean = redact(message).slice(0, 6000);
        // A closed or unresponsive app window must not prevent saving the log.
        try { this.send(clean); } catch {}
        if (this.fileUnavailable) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            if (fs.existsSync(this.file) && fs.statSync(this.file).size >= MAX_LOG_BYTES) {
                fs.rmSync(`${this.file}.previous`, { force: true });
                fs.renameSync(this.file, `${this.file}.previous`);
            }
            fs.appendFileSync(this.file, `[${new Date().toISOString()}] ${clean}\n`, { mode: 0o600 });
        } catch (error) {
            this.fileUnavailable = true;
            try { this.send(`⚠️ Could not save the diagnostic log (${error.code || 'file error'}). Use Copy Logs to keep this run's details.`); } catch {}
        }
    }

    step(label) {
        this.stage = label;
        this.stageStarted = Date.now();
        this.write(`▶ ${label}`);
    }

    attach(page, browser) {
        this.detach();
        this.notes = [];
        const started = new WeakMap();
        const mainDocument = request => request.isNavigationRequest() && request.frame() === page.mainFrame();
        const relevant = request => /^(?:document|xhr|fetch)$/.test(request.resourceType()) &&
            /(^|\.)gameflip\.com$/.test(new URL(request.url()).hostname);
        const note = value => { this.notes.push(value); this.notes = this.notes.slice(-8); };
        const on = (target, event, handler) => {
            target.on(event, handler);
            this.listeners.push(() => target.off(event, handler));
        };
        on(page, 'request', request => {
            if (!mainDocument(request)) return;
            started.set(request, Date.now());
            this.write(`Opening ${request.method()} ${safeUrl(request.url())}`);
        });
        on(page, 'response', response => {
            const request = response.request();
            if (mainDocument(request)) {
                const elapsed = Date.now() - (started.get(request) || Date.now());
                const cached = response.status() === 304 ? ' (Not Modified; checking rendered page)' : response.fromCache() ? ' (from cache)' : '';
                this.write(`HTTP ${response.status()}${cached} ${safeUrl(response.url())} (${elapsed}ms)`);
            } else if (response.status() >= 400 && relevant(request)) {
                note(`HTTP ${response.status()} ${request.method()} ${safeUrl(response.url())}`);
            }
        });
        on(page, 'requestfailed', request => {
            if (relevant(request)) note(`${request.failure()?.errorText || 'Request failed'} ${request.method()} ${safeUrl(request.url())}`);
        });
        on(page, 'pageerror', error => note(`Page script: ${error.message}`));
        on(page, 'error', error => note(`Browser page crash: ${error.message}`));
        on(page, 'automation-popup', message => this.write(message));
        on(page, 'close', () => note('Browser page closed unexpectedly.'));
        on(browser, 'disconnected', () => note('Chrome disconnected unexpectedly.'));
    }

    detach() {
        for (const remove of this.listeners.splice(0)) remove();
    }

    async report(error, page, postedCount) {
        this.reportedError = error;
        const elapsed = ((Date.now() - this.stageStarted) / 1000).toFixed(1);
        this.write(`⚠️ Posting paused during "${this.stage}" after ${elapsed}s; ${postedCount} confirmed posts. ${error.name}: ${error.message}`);
        if (page) {
            this.write(`Last page: ${safeUrl(page.url())}; browser page ${page.isClosed() ? 'closed' : 'open'}.`);
            if (!page.isClosed()) {
                let timer;
                try {
                    const state = await Promise.race([
                        page.evaluate(() => {
                            const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
                            const controls = [...document.querySelectorAll('button, a, input[type="submit"], [role="button"]')]
                                .filter(visible).filter(el => !el.closest('header, nav, .navbar'));
                            const has = label => controls.some(el => label.test((el.innerText || el.value || '').trim()));
                            return { ready: document.readyState, draftCopies: document.querySelectorAll('.tool-duplicate').length,
                                done: has(/^done$/i), listItem: has(/^list item$/i),
                                dialogs: [...document.querySelectorAll('.modal, [role="dialog"]')].filter(visible).length };
                        }),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page inspection timed out')), 2000); })
                    ]);
                    this.write(`Page state: ${JSON.stringify(state)}`);
                } catch (inspectionError) {
                    this.write(`Page inspection unavailable: ${inspectionError.message}`);
                } finally { clearTimeout(timer); }
            }
        }
        for (const note of this.notes) this.write(`Recent browser/network issue: ${note}`);
        if (error.stack) this.write(`Error details:\n${error.stack.split('\n').slice(0, 6).join('\n')}`);
        for (let cause = error.cause, depth = 0; cause && depth < 3; cause = cause.cause, depth++) {
            this.write(`Caused by: ${cause.name || 'Error'}: ${cause.message || String(cause)}`);
        }
        this.write(`Diagnostic log: ${this.file}`);
    }
}

module.exports = { RunLog, safeUrl, redact, MAX_LOG_BYTES };
