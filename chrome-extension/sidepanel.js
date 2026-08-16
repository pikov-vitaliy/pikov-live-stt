// Modified in 2026 by Vitaly Pikov for Pikov LiveSTT; based on WhisperLiveKit.
import {
    TranscriptArchive,
    TRANSCRIPT_FORMATS,
    formatLineForCopy,
    formatLinesForCopy,
    formatTranscriptMarkdown,
    makeTranscriptFilename,
    toSeconds,
} from "./transcript-archive.js";
import { copyMarkdownToClipboard, downloadMarkdown } from "./transcript-actions.js";
import { TranscriptView, isPinnedToBottom } from "./transcript-view.js";
import {
    forgetFileHandle,
    isFileWritingSupported,
    pickTranscriptFile,
    requestWritePermission,
    storeFileHandle,
    writeTranscriptFile,
} from "./transcript-file-writer.js";

const DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8001/asr";
const MAX_RENDERED_LINES = 300;
const DEFAULT_TRANSCRIPT_FONT_SIZE = 18;
const MIN_TRANSCRIPT_FONT_SIZE = 14;
const MAX_TRANSCRIPT_FONT_SIZE = 28;
const TRANSCRIPT_FONT_STEP = 2;

// Captured once: the module keeps working from timers even if the host page
// tears the global down (which is exactly what the test harness does).
const doc = document;
const element = (id) => doc.getElementById(id);

const statusElement = element("status");
const transcriptElement = element("transcript");
const websocketUrlInput = element("websocketUrl");
const stopButton = element("stopButton");
const copyMarkdownButton = element("copyMarkdownButton");
const saveMarkdownButton = element("saveMarkdownButton");
const decreaseFontButton = element("decreaseFontButton");
const increaseFontButton = element("increaseFontButton");
const transcriptFontSizeLabel = element("transcriptFontSizeLabel");
const formatSelect = element("formatSelect");
const followButton = element("followButton");
const selectionBar = element("selectionBar");
const selectionCount = element("selectionCount");
const copySelectedButton = element("copySelectedButton");
const clearSelectionButton = element("clearSelectionButton");
const linkFileButton = element("linkFileButton");
const unlinkFileButton = element("unlinkFileButton");
const fileStatusElement = element("fileStatus");
const recoveryElement = element("recovery");
const recoveryTextElement = element("recoveryText");
const restoreButton = element("restoreButton");
const discardButton = element("discardButton");
const sessionClockElement = element("sessionClock");
const pauseButton = element("pauseButton");
const resumeButton = element("resumeButton");
const clearScreenButton = element("clearScreenButton");
const microphoneToggle = element("microphoneToggle");
const microphoneStatusElement = element("microphoneStatus");
const emptyHintElement = element("emptyHint");

const scheduleFrame = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback) => setTimeout(callback, 16);

let sessionState = "idle";
let transcriptFontSize = DEFAULT_TRANSCRIPT_FONT_SIZE;
let exportFormat = "dialogue";
let followTail = true;
let renderQueued = false;
let recoveryCandidate = null;
let fileHandle = null;
let offscreenWritesFile = false;
let lastFileError = null;
let diagnostics = null;
// "Очистить экран": how much of each line was already on screen when the user
// cleared. The archive and the file are never touched — the screen is a
// viewport, not the store.
const hiddenTextByKey = new Map();

const archive = new TranscriptArchive();
const selectedKeys = new Set();

let transcriptMetadata = {
    schemaVersion: 1,
    sessionId: null,
    title: "",
    startedAt: null,
    endedAt: null,
    finalized: false,
    segments: [],
    bufferTranscription: "",
};

const view = new TranscriptView({
    container: transcriptElement,
    documentObject: doc,
    maxLines: MAX_RENDERED_LINES,
    onCopyLine: (key) => copySingleLine(key),
    onToggleLine: (key) => toggleSelection(key),
});

function localWebSocketUrl(value) {
    const parsed = new URL(value);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (
        parsed.protocol !== "ws:" ||
        !loopbackHosts.has(parsed.hostname) ||
        parsed.pathname !== "/asr"
    ) {
        throw new Error("Укажите локальный адрес вида ws://127.0.0.1:8001/asr.");
    }
    return parsed.href;
}

function setStatus(status, error) {
    statusElement.textContent = error ? `Ошибка: ${error}` : status;
}

function normalizeTranscriptFontSize(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return DEFAULT_TRANSCRIPT_FONT_SIZE;
    }

    const roundedValue = Math.round(numericValue / TRANSCRIPT_FONT_STEP) * TRANSCRIPT_FONT_STEP;
    return Math.min(MAX_TRANSCRIPT_FONT_SIZE, Math.max(MIN_TRANSCRIPT_FONT_SIZE, roundedValue));
}

function applyTranscriptFontSize(value) {
    transcriptFontSize = normalizeTranscriptFontSize(value);
    doc.documentElement.style.setProperty("--transcript-font-size", `${transcriptFontSize}px`);
    transcriptFontSizeLabel.textContent = `Размер текста: ${transcriptFontSize} px`;
    decreaseFontButton.disabled = transcriptFontSize <= MIN_TRANSCRIPT_FONT_SIZE;
    increaseFontButton.disabled = transcriptFontSize >= MAX_TRANSCRIPT_FONT_SIZE;
}

async function saveTranscriptFontSize(value) {
    applyTranscriptFontSize(value);
    try {
        await chrome.storage.local.set({ transcriptFontSize });
    } catch (error) {
        setStatus("", error instanceof Error ? error.message : String(error));
    }
}

function isCapturing() {
    return sessionState === "connecting" || sessionState === "recording" || sessionState === "stopping";
}

function formatDuration(fromIso) {
    if (!fromIso) {
        return "";
    }
    const started = new Date(fromIso).getTime();
    if (Number.isNaN(started)) {
        return "";
    }
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const pad = (number) => String(number).padStart(2, "0");
    const hours = Math.floor(seconds / 3600);
    const rest = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
    return hours ? `${hours}:${rest}` : rest;
}

function isPaused() {
    return sessionState === "paused";
}

function updateControls() {
    const live = isCapturing() || isPaused();
    stopButton.disabled = !live || sessionState === "stopping";
    websocketUrlInput.disabled = live;

    // Пауза и Продолжить занимают одно место: показана всегда ровно одна.
    pauseButton.hidden = isPaused();
    resumeButton.hidden = !isPaused();
    pauseButton.disabled = sessionState !== "recording";
    resumeButton.disabled = !isPaused();
    clearScreenButton.disabled = archive.size === 0;

    // The preference — and the one-off permission prompt behind it — must be
    // reachable at any time. Disabling the box during a capture meant the user
    // could not even ask for the microphone while anything was recording.
    // The choice simply takes effect from the next capture.
    microphoneToggle.disabled = false;

    const canExport = archive.size > 0 || Boolean(transcriptMetadata.bufferTranscription.trim());
    copyMarkdownButton.disabled = !canExport;
    saveMarkdownButton.disabled = !canExport;

    selectionBar.hidden = selectedKeys.size === 0;
    selectionCount.textContent = `Выбрано реплик: ${selectedKeys.size}`;

    const duration = formatDuration(transcriptMetadata.startedAt);
    sessionClockElement.textContent = archive.size || duration
        ? [duration, archive.size ? `${archive.size} реплик` : ""].filter(Boolean).join(" · ")
        : "";

    linkFileButton.hidden = Boolean(fileHandle);
    unlinkFileButton.hidden = !fileHandle;
    emptyHintElement.textContent = describeEmptyTranscript();
}

/**
 * An empty transcript has several very different causes — a silent tab, audio
 * that never reaches the server, a server that hears nothing. Say which.
 */
function describeEmptyTranscript() {
    if (archive.size > 0 || transcriptMetadata.bufferTranscription) {
        return "";
    }
    if (!isCapturing()) {
        return "";
    }

    const { chunksSent = 0, bytesSent = 0, updatesReceived = 0, serverStatus = "", socketOpen } = diagnostics || {};

    if (!socketOpen) {
        return "Нет соединения с локальным сервером. Проверьте, что контейнер запущен и отвечает на 127.0.0.1:8001.";
    }
    if (chunksSent === 0) {
        return "Соединение есть, но аудио из вкладки ещё не пошло. Убедитесь, что во вкладке действительно играет звук.";
    }
    if (serverStatus === "no_audio_detected") {
        const kb = Math.round(bytesSent / 1024);
        return `Отправлено ${chunksSent} фрагментов (${kb} КБ), но сервер речи не слышит.`
            + " Обычно это значит, что вкладка молчит или звук идёт мимо неё.";
    }
    return `Идёт распознавание: отправлено ${chunksSent} фрагментов, получено ${updatesReceived} обновлений.`
        + " Первые слова появляются через несколько секунд после начала речи.";
}

/** Never move the viewport out from under someone reading earlier text. */
/**
 * What the screen should show, honouring "Очистить экран".
 *
 * Hiding whole lines does not work here. The server keeps one line open until
 * it hears a five-second pause and appends everything said afterwards to that
 * same line — so hiding it buries new speech, and showing it drags the old
 * text back. Instead we remember how much of each line was already on screen
 * when the user cleared, and show only what has been added since.
 */
function visibleLines() {
    const lines = archive.tail(MAX_RENDERED_LINES);
    if (hiddenTextByKey.size === 0) {
        return lines;
    }

    const visible = [];
    for (const line of lines) {
        const hidden = hiddenTextByKey.get(String(line.start));
        if (hidden === undefined) {
            visible.push(line);
            continue;
        }
        const text = String(line.text || "");
        if (text.length <= hidden) {
            continue;
        }
        visible.push({ ...line, text: text.slice(hidden).trimStart() });
    }
    return visible;
}

function renderNow() {
    const pinned = followTail && isPinnedToBottom(transcriptElement);
    view.sync(visibleLines(), transcriptMetadata.bufferTranscription);
    if (pinned) {
        transcriptElement.scrollTop = transcriptElement.scrollHeight;
    }
    followButton.hidden = followTail;
    updateControls();
}

/**
 * Postpone redrawing only while the reader is actively dragging out a
 * selection. Deferring for as long as any selection merely EXISTS starves the
 * transcript forever — including after this panel's own double-click-to-copy,
 * which leaves one behind. The deferral is bounded as a second safeguard, and
 * a static selection is safe anyway: the view patches only the lines that
 * changed.
 */
const MAX_RENDER_DEFERRAL_MS = 1500;
let selectionDragActive = false;
let deferringSince = 0;

function requestRender() {
    if (renderQueued) {
        return;
    }
    renderQueued = true;
    scheduleFrame(() => {
        renderQueued = false;
        if (selectionDragActive) {
            if (!deferringSince) {
                deferringSince = Date.now();
            }
            if (Date.now() - deferringSince < MAX_RENDER_DEFERRAL_MS) {
                requestRender();
                return;
            }
        }
        deferringSince = 0;
        renderNow();
    });
}

function resetTranscript() {
    archive.clear();
    selectedKeys.clear();
    view.clear();
    view.setSelected(selectedKeys);
    transcriptMetadata = {
        schemaVersion: 1,
        sessionId: null,
        title: "",
        startedAt: null,
        endedAt: null,
        finalized: false,
        segments: [],
        bufferTranscription: "",
    };
    hiddenTextByKey.clear();
    panelLastWritten = null;
    followTail = true;
}

function restoreTranscript(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
        return false;
    }

    archive.replace(snapshot.lines);
    // Rows keep their highlight unless the view is told the set changed.
    selectedKeys.clear();
    view.setSelected(selectedKeys);
    transcriptMetadata = {
        schemaVersion: Number(snapshot.schemaVersion) || 1,
        sessionId: snapshot.sessionId || null,
        title: String(snapshot.title || ""),
        startedAt: snapshot.startedAt || null,
        endedAt: snapshot.endedAt || null,
        finalized: Boolean(snapshot.finalized),
        segments: Array.isArray(snapshot.segments) ? snapshot.segments : [],
        bufferTranscription: String(snapshot.bufferTranscription || ""),
    };
    return true;
}

function markdownForExport(format = exportFormat) {
    return formatTranscriptMarkdown({
        ...transcriptMetadata,
        lines: archive.lines,
        format,
        preMerged: true,
    });
}

function applySnapshot(snapshot, error) {
    sessionState = snapshot?.state || "idle";
    diagnostics = snapshot?.diagnostics || diagnostics;
    if (!restoreTranscript(snapshot?.transcript) && sessionState === "connecting") {
        resetTranscript();
    }
    if (isCapturing() || isPaused()) {
        // An offer to restore an older meeting has no place on screen while a
        // new one is being recorded — accepting it would replace live text.
        hideRecovery();
    }
    setStatus(snapshot?.status || "Готово к началу транскрипции.", error);
    renderNow();
}

async function copyText(text, confirmation) {
    if (!text) {
        setStatus("", "Нет текста для копирования.");
        return;
    }
    try {
        await copyMarkdownToClipboard(text);
        setStatus(confirmation);
    } catch (error) {
        setStatus("", error instanceof Error ? error.message : String(error));
    }
}

function copySingleLine(key) {
    const line = view.lineAt(key);
    if (!line) {
        return;
    }
    // A double click leaves the word selected; the text is already copied, so
    // clear it rather than let it sit there blocking redraws.
    doc.getSelection?.()?.removeAllRanges?.();
    selectionDragActive = false;
    void copyText(formatLineForCopy(line), "Реплика скопирована.");
}

function toggleSelection(key) {
    if (selectedKeys.has(key)) {
        selectedKeys.delete(key);
    } else {
        selectedKeys.add(key);
    }
    view.setSelected(selectedKeys);
    updateControls();
}

function selectedLines() {
    return archive.lines.filter((line) => selectedKeys.has(String(line.start)));
}

// ---------------------------------------------------------------------------
// Live file on disk
// ---------------------------------------------------------------------------

function setFileStatus(text) {
    fileStatusElement.textContent = text;
}

function setMicrophoneStatus(text) {
    microphoneStatusElement.textContent = text;
}

/** Has the extension origin already been granted the microphone? */
async function microphoneGranted() {
    try {
        const status = await navigator.permissions?.query?.({ name: "microphone" });
        return status?.state === "granted";
    } catch {
        // Some builds do not expose the query; assume not granted and let the
        // one-off request page decide.
        return false;
    }
}

/**
 * Writes the file from the panel. Used only when the offscreen document cannot
 * write it itself, in which case the file stops updating while the panel is
 * closed — and the status line says so rather than pretending otherwise.
 */
let panelWriteQueue = Promise.resolve();
let panelLastWritten = null;

async function writeFileFromPanel() {
    if (!fileHandle || offscreenWritesFile) {
        return;
    }

    // Serialised and deduplicated, exactly like TranscriptFileWriter. Firing
    // this straight from the transcript handler means up to twenty calls a
    // second, and each one truncates the file before rewriting it — overlapping
    // writes on one handle would leave it empty or half-written.
    panelWriteQueue = panelWriteQueue.then(async () => {
        if (!fileHandle || offscreenWritesFile) {
            return;
        }
        const contents = markdownForExport("dialogue");
        if (contents === panelLastWritten) {
            return;
        }
        try {
            await writeTranscriptFile(fileHandle, contents);
            panelLastWritten = contents;
            lastFileError = null;
        } catch (error) {
            lastFileError = error instanceof Error ? error.message : String(error);
            setFileStatus(`Запись в файл не удалась: ${lastFileError}`);
        }
    });
    return panelWriteQueue;
}

/** The meeting the file belonged to is over: stop holding its handle. */
function releaseFileLink(reason) {
    const wasLinked = Boolean(fileHandle);
    fileHandle = null;
    panelLastWritten = null;
    offscreenWritesFile = false;
    // Always clear the status: leaving "файл обновляется" on screen after the
    // file has been released is exactly the false claim this fix is about.
    setFileStatus(wasLinked ? reason : "");
    updateControls();
}

async function linkLiveFile() {
    if (!isFileWritingSupported()) {
        // Brave ships the File System Access API disabled by default; Chrome and
        // Edge have it on. Say what to do rather than just what is missing.
        setFileStatus(
            "Запись в файл выключена в браузере. В Brave: откройте brave://flags, найдите «File System Access API», "
            + "включите и перезапустите браузер. Либо используйте «Сохранить .md» или Chrome/Edge.",
        );
        return;
    }

    try {
        const suggestedName = makeTranscriptFilename(new Date(), transcriptMetadata.title);
        const handle = await pickTranscriptFile({ suggestedName });
        if (!(await requestWritePermission(handle))) {
            setFileStatus("Разрешение на запись не выдано.");
            return;
        }

        await storeFileHandle(handle);
        fileHandle = handle;

        // Probe once from here, then hand writing to the offscreen document so
        // the file keeps growing after this panel is closed.
        await writeTranscriptFile(handle, markdownForExport("dialogue"));
        await chrome.runtime.sendMessage({ target: "offscreen", type: "file-attached" }).catch(() => {});
        setFileStatus(`Пишу в ${handle.name}. Во время записи рядом ненадолго появляется файл .crswap — это нормально.`);
    } catch (error) {
        if (error?.name === "AbortError") {
            return;
        }
        setFileStatus(`Не удалось подключить файл: ${error instanceof Error ? error.message : String(error)}`);
    }
    updateControls();
}

async function unlinkLiveFile() {
    fileHandle = null;
    offscreenWritesFile = false;
    try {
        await forgetFileHandle();
    } catch {
        // Nothing to clean up if the store was never created.
    }
    await chrome.runtime.sendMessage({ target: "offscreen", type: "file-detached" }).catch(() => {});
    setFileStatus("Живая запись в файл отключена.");
    updateControls();
}

// ---------------------------------------------------------------------------
// Recovery of an interrupted meeting
// ---------------------------------------------------------------------------

function describeSaved(session) {
    const when = session?.savedAt ? new Date(session.savedAt) : null;
    const stamp = when && !Number.isNaN(when.getTime())
        ? `${String(when.getDate()).padStart(2, "0")}.${String(when.getMonth() + 1).padStart(2, "0")} в ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
        : "дата неизвестна";
    const name = session?.title ? `«${session.title}»` : "встреча без названия";
    const count = session?.summary?.lineCount ?? 0;
    const preview = String(session?.summary?.preview || "").trim();
    const head = `${name}, ${stamp} — ${count} реплик.`;
    return preview ? `${head} Начало: «${preview.slice(0, 100)}…»` : head;
}

function showRecovery(session) {
    recoveryCandidate = session;
    recoveryTextElement.textContent = describeSaved(session);
    recoveryElement.hidden = false;
}

function hideRecovery() {
    recoveryCandidate = null;
    recoveryElement.hidden = true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== "ui") {
        return;
    }

    if (message.type === "session-state") {
        applySnapshot(message.snapshot, message.error);
    } else if (message.type === "transcript") {
        diagnostics = message.diagnostics || diagnostics;
        archive.merge(message.data);
        transcriptMetadata.bufferTranscription = String(message.data?.buffer_transcription || "");
        requestRender();
        void writeFileFromPanel();
    } else if (message.type === "error") {
        // Show the failure without touching session state: the capture the
        // panel is attached to may well still be running.
        setStatus("", message.error || "Не удалось запустить транскрипцию.");
    } else if (message.type === "file-released") {
        releaseFileLink("Файл этой встречи отвязан. Для новой записи выберите файл заново.");
    } else if (message.type === "file-status") {
        offscreenWritesFile = Boolean(message.status?.attached);
        lastFileError = message.status?.error || null;
        if (lastFileError) {
            setFileStatus(`Запись в файл не удалась: ${lastFileError}`);
        } else if (offscreenWritesFile) {
            setFileStatus("Файл обновляется, даже когда панель закрыта.");
        } else if (fileHandle) {
            setFileStatus("Файл обновляется только пока панель открыта.");
        } else {
            setFileStatus("");
        }
    } else if (message.type === "background-failure") {
        // A failure in autosave or file writing must be readable here rather
        // than only as an anonymous rejection in the extension's error log.
        setStatus("", `Фоновая операция «${message.what}» не удалась: ${message.error}`);
    } else if (message.type === "persistence-error") {
        setStatus("", message.error || "Не удалось временно сохранить стенограмму. Сохраните .md до начала новой встречи.");
    }
});

websocketUrlInput.addEventListener("change", async () => {
    try {
        const normalized = localWebSocketUrl(websocketUrlInput.value.trim());
        websocketUrlInput.value = normalized;
        await chrome.storage.local.set({ websocketUrl: normalized });
        setStatus("Адрес сохранён для следующей встречи.");
    } catch (error) {
        websocketUrlInput.value = DEFAULT_WEBSOCKET_URL;
        setStatus("", error instanceof Error ? error.message : String(error));
    }
});

formatSelect.addEventListener("change", async () => {
    exportFormat = TRANSCRIPT_FORMATS.includes(formatSelect.value) ? formatSelect.value : "dialogue";
    try {
        await chrome.storage.local.set({ exportFormat });
    } catch {
        // A remembered preference is a convenience, not a requirement.
    }
});

stopButton.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch((error) => {
        setStatus("", error.message);
    });
});

pauseButton.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ target: "offscreen", type: "pause" }).catch(() => {});
    void chrome.runtime.sendMessage({ target: "background", type: "paused-capture" }).catch(() => {});
    setStatus("Пауза. Файл сохранён до этого места; продолжите, когда понадобится.");
});

resumeButton.addEventListener("click", () => {
    // Routed through the worker: it reads the tab's current title so the new
    // segment is named after whatever is playing now.
    void chrome.runtime.sendMessage({ target: "background", type: "resume-capture" })
        .then((reply) => {
            setStatus(reply?.title
                ? `Записываю: ${reply.title}`
                : "Запись продолжена.");
        })
        .catch((error) => setStatus("", error?.message || String(error)));
});

clearScreenButton.addEventListener("click", () => {
    // Only the viewport is cleared. The archive, the .md and the autosave keep
    // everything — otherwise a stray click would destroy the evening's notes.
    for (const line of archive.lines) {
        hiddenTextByKey.set(String(line.start), String(line.text || "").length);
    }
    selectedKeys.clear();
    view.clear();
    followTail = true;
    renderNow();
    setStatus("Экран очищен. В файл всё продолжает записываться.");
});

microphoneToggle.addEventListener("change", async () => {
    const wanted = Boolean(microphoneToggle.checked);
    try {
        await chrome.storage.local.set({ recordMicrophone: wanted });
    } catch {
        // A remembered preference is a convenience, not a requirement.
    }

    if (!wanted) {
        setMicrophoneStatus(isCapturing() || isPaused()
            ? "Текущая запись продолжается с микрофоном — настройка применится со следующего запуска захвата."
            : "Микрофон не записывается — в стенограмму попадут только участники.");
        return;
    }

    const applies = isCapturing() || isPaused()
        ? " Текущая запись уже идёт без него — он подключится со следующего запуска захвата."
        : "";

    const granted = await microphoneGranted();
    if (granted) {
        setMicrophoneStatus(`Доступ к микрофону есть.${applies || " Он будет записан вместе со звуком вкладки."}`);
        return;
    }

    setMicrophoneStatus(`Нужно один раз разрешить доступ — открываю страницу запроса.${applies}`);
    await chrome.runtime.sendMessage({ target: "background", type: "request-microphone" }).catch(() => {});
});

copyMarkdownButton.addEventListener("click", () => {
    void copyText(markdownForExport(), "Стенограмма скопирована в буфер обмена.");
});

copySelectedButton.addEventListener("click", () => {
    const lines = selectedLines();
    const asMarkdown = exportFormat !== "plain";
    void copyText(
        formatLinesForCopy(lines, { markdown: asMarkdown }),
        `Скопировано реплик: ${lines.length}.`,
    );
});

clearSelectionButton.addEventListener("click", () => {
    selectedKeys.clear();
    view.setSelected(selectedKeys);
    updateControls();
});

saveMarkdownButton.addEventListener("click", () => {
    try {
        const filename = downloadMarkdown(
            markdownForExport(),
            makeTranscriptFilename(transcriptMetadata.endedAt || new Date(), transcriptMetadata.title),
        );
        setStatus(`Файл ${filename} сохранён в папку загрузок браузера.`);
    } catch (error) {
        setStatus("", error instanceof Error ? error.message : String(error));
    }
});

followButton.addEventListener("click", () => {
    followTail = true;
    transcriptElement.scrollTop = transcriptElement.scrollHeight;
    followButton.hidden = true;
});

transcriptElement.addEventListener("pointerdown", () => {
    selectionDragActive = true;
});

doc.addEventListener?.("pointerup", () => {
    if (selectionDragActive) {
        selectionDragActive = false;
        requestRender();
    }
});

transcriptElement.addEventListener("scroll", () => {
    const pinned = isPinnedToBottom(transcriptElement);
    if (pinned !== followTail) {
        followTail = pinned;
        followButton.hidden = pinned;
    }
});

linkFileButton.addEventListener("click", () => {
    void linkLiveFile();
});

unlinkFileButton.addEventListener("click", () => {
    void unlinkLiveFile();
});

restoreButton.addEventListener("click", () => {
    if (!recoveryCandidate?.snapshot) {
        return;
    }
    if (isCapturing() || isPaused() || archive.size > 0) {
        setStatus("", "Сейчас идёт запись. Сначала остановите её, иначе текущая стенограмма будет заменена.");
        return;
    }
    restoreTranscript(recoveryCandidate.snapshot);
    hideRecovery();
    setStatus("Стенограмма восстановлена. Сохраните .md, чтобы закрепить результат.");
    renderNow();
});

discardButton.addEventListener("click", () => {
    const id = recoveryCandidate?.id;
    hideRecovery();
    if (id) {
        void chrome.runtime.sendMessage({ target: "background", type: "delete-saved-transcript", id }).catch(() => {});
    }
    setStatus("Сохранённая стенограмма удалена.");
});

decreaseFontButton.addEventListener("click", async () => {
    await saveTranscriptFontSize(transcriptFontSize - TRANSCRIPT_FONT_STEP);
});

increaseFontButton.addEventListener("click", async () => {
    await saveTranscriptFontSize(transcriptFontSize + TRANSCRIPT_FONT_STEP);
});

async function initialize() {
    const settings = await chrome.storage.local.get({
        websocketUrl: DEFAULT_WEBSOCKET_URL,
        transcriptFontSize: DEFAULT_TRANSCRIPT_FONT_SIZE,
        exportFormat: "dialogue",
        recordMicrophone: false,
    });
    microphoneToggle.checked = Boolean(settings.recordMicrophone);
    setMicrophoneStatus(settings.recordMicrophone
        ? "Микрофон записывается вместе со звуком вкладки."
        : "Микрофон не записывается — в стенограмму попадут только участники.");
    applyTranscriptFontSize(settings.transcriptFontSize);
    exportFormat = TRANSCRIPT_FORMATS.includes(settings.exportFormat) ? settings.exportFormat : "dialogue";
    formatSelect.value = exportFormat;

    try {
        websocketUrlInput.value = localWebSocketUrl(settings.websocketUrl);
    } catch {
        websocketUrlInput.value = DEFAULT_WEBSOCKET_URL;
    }

    // Ask the offscreen document first: only once we know whether a capture is
    // running can we tell a crashed meeting from the one on screen.
    let live = null;
    try {
        live = await chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" });
    } catch {
        live = null;
    }

    if (live?.snapshot) {
        applySnapshot(live.snapshot);
        offscreenWritesFile = Boolean(live.file?.attached);
    } else {
        const saved = await chrome.storage.session.get({ lastTranscript: null });
        if (restoreTranscript(saved.lastTranscript)) {
            setStatus(saved.lastTranscript.finalized
                ? "Доступна завершённая стенограмма. Сохраните .md."
                : "Доступна незавершённая стенограмма. Сохраните .md.");
        } else {
            setStatus("Готово. Откройте вкладку конференции и нажмите иконку расширения.");
        }
        renderNow();

        const stored = await chrome.runtime
            .sendMessage({ target: "background", type: "list-saved-transcripts" })
            .catch(() => null);
        const unfinished = (stored?.sessions || []).find((session) => !session.finalized);
        if (unfinished && unfinished.snapshot?.lines?.length && !archive.size) {
            showRecovery(unfinished);
        }
    }

    updateControls();
}

void initialize();
