const fs = require('node:fs');
const path = require('node:path');

const POST_INTERVAL_MS = 220000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 400;
const CONFIRMATION_TIMEOUT_MS = 90000;

class PostingBudget {
    constructor(file, { now = Date.now } = {}) {
        this.file = file;
        this.now = now;
    }

    load(now) {
        if (!fs.existsSync(this.file)) return { version: 1, submissions: [], cooldownUntil: 0 };
        try {
            const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (state.version !== 1 || !Array.isArray(state.submissions) ||
                state.submissions.some(at => !Number.isFinite(at) || at < 0) ||
                !Number.isFinite(state.cooldownUntil) || state.cooldownUntil < 0) throw new Error('Invalid history');
            return { ...state, submissions: state.submissions.filter(at => at > now - DAY_MS).sort((a, b) => a - b) };
        } catch {
            throw new Error('Posting history could not be read. Restore the local history file before posting; limits were not reset.');
        }
    }

    status() {
        const now = this.now();
        return this.check(this.load(now), now);
    }

    check(state, now) {
        const history = state.submissions;
        if (history.length >= DAILY_LIMIT) {
            throw new Error(`Daily limit reached: ${DAILY_LIMIT} app submissions in the last 24 hours. Next slot: ${new Date(history[history.length - DAILY_LIMIT] + DAY_MS).toLocaleString()}.`);
        }
        return { count: history.length, waitMs: Math.max(0, state.cooldownUntil - now) };
    }

    reserve() {
        const now = this.now();
        const state = this.load(now);
        const status = this.check(state, now);
        if (status.waitMs > 0) throw new Error(`The 220-second posting interval has not elapsed (${Math.ceil(status.waitMs / 1000)} seconds remain).`);
        state.submissions.push(now);
        // A crash during confirmation must not permit an immediate restart.
        state.cooldownUntil = now + CONFIRMATION_TIMEOUT_MS + POST_INTERVAL_MS;
        this.save(state);
        return state.submissions.length;
    }

    finishAttempt() {
        const now = this.now();
        const state = this.load(now);
        state.cooldownUntil = now + POST_INTERVAL_MS;
        this.save(state);
    }

    save(state) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
            fs.renameSync(temporary, this.file);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
    }
}

module.exports = { PostingBudget, POST_INTERVAL_MS, DAY_MS, DAILY_LIMIT, CONFIRMATION_TIMEOUT_MS };
