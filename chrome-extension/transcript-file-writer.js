/**
 * Keeps a real `.md` file on disk in step with the running transcript, so it
 * can be left open in an editor and watched as the meeting proceeds.
 *
 * Division of labour, forced by how the platform works:
 *  - `showSaveFilePicker` needs a user gesture and a visible window, so the
 *    file is chosen from the side panel.
 *  - The panel may be closed at any time while capture continues, so the
 *    handle is parked in IndexedDB, which every context of this extension's
 *    origin shares, and the offscreen document — the only context that lives
 *    for the whole meeting — picks it up and does the writing.
 *
 * Write permission is granted per origin and survives until every context of
 * that origin is gone, so the offscreen document can write without a gesture
 * of its own. It does NOT survive a browser restart: the panel has to re-ask,
 * which is why `requestWritePermission` must be called from a click handler.
 */

const DB_NAME = "wlk-transcript-file";
const DB_VERSION = 1;
const STORE_NAME = "handles";
export const ACTIVE_HANDLE_KEY = "activeTranscriptFile";

export function isFileWritingSupported(scope = globalThis) {
    return typeof scope?.showSaveFilePicker === "function";
}

export function canStoreHandle(scope = globalThis) {
    return typeof scope?.indexedDB === "object" && scope.indexedDB !== null;
}

function openDatabase(scope = globalThis) {
    return new Promise((resolve, reject) => {
        const request = scope.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function runTransaction(database, mode, operation) {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = operation(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

export async function storeFileHandle(handle, { scope = globalThis, key = ACTIVE_HANDLE_KEY } = {}) {
    const database = await openDatabase(scope);
    try {
        await runTransaction(database, "readwrite", (store) => store.put(handle, key));
    } finally {
        database.close();
    }
}

export async function loadFileHandle({ scope = globalThis, key = ACTIVE_HANDLE_KEY } = {}) {
    if (!canStoreHandle(scope)) {
        return null;
    }
    const database = await openDatabase(scope);
    try {
        return (await runTransaction(database, "readonly", (store) => store.get(key))) || null;
    } finally {
        database.close();
    }
}

export async function forgetFileHandle({ scope = globalThis, key = ACTIVE_HANDLE_KEY } = {}) {
    const database = await openDatabase(scope);
    try {
        await runTransaction(database, "readwrite", (store) => store.delete(key));
    } finally {
        database.close();
    }
}

export async function hasWritePermission(handle) {
    if (typeof handle?.queryPermission !== "function") {
        return false;
    }
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

/** Must be called from a user gesture; Chrome rejects it otherwise. */
export async function requestWritePermission(handle) {
    if (await hasWritePermission(handle)) {
        return true;
    }
    if (typeof handle?.requestPermission !== "function") {
        return false;
    }
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

/**
 * Ask the user where the live transcript should go. Chrome remembers the last
 * directory per `id`, so the next meeting opens where the previous one was
 * saved while still letting a different folder be chosen per meeting.
 */
export async function pickTranscriptFile({ suggestedName = "стенограмма.md", scope = globalThis } = {}) {
    if (!isFileWritingSupported(scope)) {
        throw new Error("Этот браузер не поддерживает запись в выбранный файл.");
    }
    return scope.showSaveFilePicker({
        id: "wlk-transcript",
        startIn: "documents",
        suggestedName,
        types: [{
            description: "Markdown",
            accept: { "text/markdown": [".md"] },
        }],
    });
}

/**
 * Replace the file's contents. The transcript is rewritten in full rather than
 * appended to, because the streaming policy revises text it has already sent —
 * appending would leave stale sentences behind.
 */
export async function writeTranscriptFile(handle, contents) {
    const writable = await handle.createWritable();
    try {
        await writable.write(contents);
    } finally {
        await writable.close();
    }
}

/**
 * Serialises writes and skips ones that would not change the file, so a
 * twenty-per-second update stream costs one write per real change.
 */
export class TranscriptFileWriter {
    constructor({ loadHandle = loadFileHandle, write = writeTranscriptFile } = {}) {
        this.loadHandle = loadHandle;
        this.write = write;
        this.handle = null;
        this.lastWritten = null;
        this.queue = Promise.resolve();
        this.lastError = null;
    }

    async attach() {
        this.handle = await this.loadHandle();
        return Boolean(this.handle);
    }

    detach() {
        this.handle = null;
        this.lastWritten = null;
    }

    get isAttached() {
        return Boolean(this.handle);
    }

    /** Resolves to true when the file now holds `contents`. */
    flush(contents) {
        this.queue = this.queue.then(async () => {
            if (!this.handle || contents === this.lastWritten) {
                return false;
            }
            if (!(await hasWritePermission(this.handle))) {
                this.lastError = "Нет разрешения на запись в выбранный файл.";
                return false;
            }
            await this.write(this.handle, contents);
            this.lastWritten = contents;
            this.lastError = null;
            return true;
        }).catch((error) => {
            this.lastError = error instanceof Error ? error.message : String(error);
            return false;
        });
        return this.queue;
    }
}
