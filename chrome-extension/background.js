import { TranscriptStore } from "./transcript-store.js";

const DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8001/asr";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const SIDEPANEL_PATH = "sidepanel.html";

let creatingOffscreenDocument;

const store = new TranscriptStore({ storage: chrome.storage.local });

function localWebSocketUrl(value) {
    const parsed = new URL(value);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

    if (parsed.protocol !== "ws:" || !loopbackHosts.has(parsed.hostname)) {
        throw new Error("The transcription server must be a local ws:// endpoint.");
    }
    if (parsed.pathname !== "/asr") {
        throw new Error("The transcription server path must be /asr.");
    }

    return parsed.href;
}

async function ensureOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
    });

    if (existingContexts.length > 0) {
        return;
    }

    if (!creatingOffscreenDocument) {
        creatingOffscreenDocument = chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ["USER_MEDIA"],
            justification: "Capture the selected conference tab for local transcription.",
        }).finally(() => {
            creatingOffscreenDocument = undefined;
        });
    }

    await creatingOffscreenDocument;
}

/** A running capture is visible from every tab, not only from the panel. */
function showRecordingBadge(active, pausedLabel = "") {
    try {
        chrome.action.setBadgeText({ text: active ? "REC" : pausedLabel });
        chrome.action.setBadgeBackgroundColor({ color: active ? "#c0392b" : "#7f8c8d" });
    } catch {
        // Badges are cosmetic; never let them break a capture.
    }
}

async function startCaptureForTab(tab) {
    if (!tab?.id) {
        throw new Error("Open the conference in a browser tab before starting transcription.");
    }

    // Call open synchronously in the action-click handler: Chrome requires a
    // user gesture for sidePanel.open(), and awaits below may lose it.
    const panelOpen = chrome.sidePanel.open({ tabId: tab.id });
    const panelOptions = chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: SIDEPANEL_PATH,
        enabled: true,
    });

    const activeCapture = await chrome.storage.session.get({ activeCaptureTabId: null });
    if (activeCapture.activeCaptureTabId === tab.id) {
        await panelOptions;
        await panelOpen;
        return;
    }

    const settings = await chrome.storage.local.get({
        websocketUrl: DEFAULT_WEBSOCKET_URL,
        recordMicrophone: false,
    });
    const websocketUrl = localWebSocketUrl(settings.websocketUrl);

    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    await panelOptions;
    await panelOpen;

    await chrome.storage.session.set({ activeCaptureTabId: tab.id });
    try {
        await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "start",
            streamId,
            sourceTabId: tab.id,
            // The tab title names the meeting in the export and the filename.
            title: tab.title || "",
            withMicrophone: Boolean(settings.recordMicrophone),
            websocketUrl,
        });
        showRecordingBadge(true);
    } catch (error) {
        await chrome.storage.session.remove("activeCaptureTabId");
        throw error;
    }
}

function publishError(message) {
    // Report the failure only. Fabricating a session-state snapshot here would
    // tell the panel the session is idle while the offscreen document is still
    // capturing, leaving "Остановить транскрипцию" disabled with no way back.
    void chrome.runtime.sendMessage({
        target: "ui",
        type: "error",
        error: message,
    }).catch(() => {});
}

function publishPersistenceError(error) {
    const detail = error instanceof Error ? error.message : String(error);
    void chrome.runtime.sendMessage({
        target: "ui",
        type: "persistence-error",
        error: `Не удалось временно сохранить стенограмму: ${detail}`,
    }).catch(() => {});
}

/** Durable copy first, then the in-memory session copy the panel reads. */
async function retainTranscript(snapshot, { finalized = false } = {}) {
    if (!snapshot) {
        return;
    }
    await store.save(snapshot.sessionId || "current", snapshot, {
        title: snapshot.title || "",
        finalized,
    });
}

async function finishCapture(message) {
    let keepOffscreen = Boolean(message.keepOffscreen);
    try {
        if (message.completedTranscript) {
            await retainTranscript(message.completedTranscript, { finalized: true });
            await chrome.storage.session.set({ lastTranscript: message.completedTranscript });
        }
    } catch (error) {
        keepOffscreen = true;
        publishPersistenceError(error);
    }

    showRecordingBadge(false);
    await chrome.storage.session.remove("activeCaptureTabId");
    if (!keepOffscreen) {
        await chrome.offscreen.closeDocument();
    }
}

chrome.action.onClicked.addListener(async (tab) => {
    try {
        await startCaptureForTab(tab);
    } catch (error) {
        console.error("Could not start tab transcription:", error);
        publishError(error instanceof Error ? error.message : String(error));
    }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "background") {
        return undefined;
    }

    if (message.type === "session-started") {
        // The retained transcript is deliberately NOT dropped here. A new
        // capture starting is not evidence that the previous meeting has been
        // exported, and it is replaced anyway when this session ends.
        return undefined;
    }

    if (message.type === "autosave") {
        void retainTranscript(message.snapshot).catch((error) => publishPersistenceError(error));
        return undefined;
    }

    if (message.type === "transcript-preempted") {
        void (async () => {
            await retainTranscript(message.completedTranscript);
            await chrome.storage.session.set({ lastTranscript: message.completedTranscript });
        })().catch((error) => publishPersistenceError(error));
        return undefined;
    }

    if (message.type === "session-ended") {
        void finishCapture(message).catch((error) => {
            publishPersistenceError(error);
        });
        return undefined;
    }

    if (message.type === "request-microphone") {
        // getUserMedia can run in the offscreen document, but the permission
        // prompt cannot: that context has no UI. A one-off extension page in a
        // real tab is the supported way to obtain the grant, after which the
        // offscreen document inherits it.
        void chrome.tabs.create({ url: chrome.runtime.getURL("requestPermissions.html") })
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (message.type === "resume-capture") {
        // The tab's title is read here, in the worker: it names the segment
        // after whatever is playing now, and offscreen documents have no
        // access to the tabs API.
        void (async () => {
            const { activeCaptureTabId } = await chrome.storage.session.get({ activeCaptureTabId: null });
            let title = "";
            if (activeCaptureTabId !== null) {
                try {
                    title = (await chrome.tabs.get(activeCaptureTabId))?.title || "";
                } catch {
                    // Tab gone or not readable — an unnamed segment is fine.
                }
            }
            await chrome.runtime.sendMessage({ target: "offscreen", type: "resume", title });
            showRecordingBadge(true);
            sendResponse({ ok: true, title });
        })().catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (message.type === "paused-capture") {
        showRecordingBadge(false, "II");
        return undefined;
    }

    if (message.type === "list-saved-transcripts") {
        void store.list()
            .then((sessions) => sendResponse({ sessions }))
            .catch(() => sendResponse({ sessions: [] }));
        return true;
    }

    if (message.type === "delete-saved-transcript") {
        void store.remove(message.id)
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
        return true;
    }

    return undefined;
});
