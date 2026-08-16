/**
 * Durable autosave for meeting transcripts.
 *
 * `chrome.storage.session` disappears when the browser restarts, and until now
 * a transcript was only written there once, after a clean stop. A crash, an
 * extension reload or a misclick therefore took the whole meeting with it.
 * This store keeps the running transcript in `chrome.storage.local`, which
 * survives a browser restart, and prunes itself so meeting text does not
 * accumulate in the browser profile indefinitely.
 *
 * Only the service worker uses this: offscreen documents are documented to
 * support the `runtime` API alone, which is what made an earlier attempt to
 * touch `chrome.storage` from the offscreen document fail in Brave.
 */

export const SESSIONS_KEY = "savedTranscripts";
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MAX_SESSIONS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

function summarize(snapshot) {
    const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
    const text = lines.map((line) => line.text).join(" ");
    return {
        lineCount: lines.length,
        characters: text.length,
        preview: text.slice(0, 160),
    };
}

export class TranscriptStore {
    constructor({
        storage,
        now = () => Date.now(),
        retentionDays = DEFAULT_RETENTION_DAYS,
        maxSessions = DEFAULT_MAX_SESSIONS,
    }) {
        this.storage = storage;
        this.now = now;
        this.retentionDays = retentionDays;
        this.maxSessions = maxSessions;
        /** Serialises writes so two quick autosaves cannot interleave. */
        this.queue = Promise.resolve();
    }

    async read() {
        const stored = await this.storage.get({ [SESSIONS_KEY]: [] });
        const sessions = Array.isArray(stored?.[SESSIONS_KEY]) ? stored[SESSIONS_KEY] : [];
        return sessions.filter((session) => session && typeof session.id === "string");
    }

    prune(sessions) {
        const cutoff = this.now() - this.retentionDays * DAY_MS;
        return sessions
            .filter((session) => Number(session.savedAt) >= cutoff)
            .sort((left, right) => Number(right.savedAt) - Number(left.savedAt))
            .slice(0, this.maxSessions);
    }

    /** Run `mutate` against the stored list, one writer at a time. */
    write(mutate) {
        this.queue = this.queue.then(async () => {
            const sessions = await this.read();
            const next = this.prune(mutate(sessions));
            await this.storage.set({ [SESSIONS_KEY]: next });
            return next;
        }).catch((error) => {
            // Keep the chain alive; the caller sees the rejection below.
            this.queue = Promise.resolve();
            throw error;
        });
        return this.queue;
    }

    save(id, snapshot, { title = "", finalized = false } = {}) {
        const record = {
            id,
            title,
            finalized: Boolean(finalized) || Boolean(snapshot?.finalized),
            savedAt: this.now(),
            snapshot,
            summary: summarize(snapshot),
        };
        return this.write((sessions) => [record, ...sessions.filter((session) => session.id !== id)]);
    }

    remove(id) {
        return this.write((sessions) => sessions.filter((session) => session.id !== id));
    }

    clear() {
        return this.write(() => []);
    }

    async list() {
        const sessions = await this.read();
        const pruned = this.prune(sessions);
        if (pruned.length !== sessions.length) {
            await this.storage.set({ [SESSIONS_KEY]: pruned });
        }
        return pruned;
    }

    async latest() {
        const sessions = await this.list();
        return sessions[0] || null;
    }

    /** The most recent session that never reached a clean finish. */
    async latestUnfinished() {
        const sessions = await this.list();
        return sessions.find((session) => !session.finalized) || null;
    }
}
