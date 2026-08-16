import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = dirname(testDirectory);

function readExtensionFile(name) {
  return readFileSync(join(extensionDirectory, name), "utf8");
}

/** The side panel coalesces renders into one animation frame. */
function settleRender() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function createBackgroundHarness() {
  let actionClickHandler;
  let runtimeMessageHandler;
  const calls = [];
  const sessionStorage = {};
  const localStorage = {};

  const chrome = {
    action: {
      onClicked: {
        addListener(handler) {
          actionClickHandler = handler;
        },
      },
      setBadgeText: (options) => { calls.push({ type: "badge", ...options }); },
      setBadgeBackgroundColor: () => {},
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
      getContexts: async () => [],
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(handler) {
          runtimeMessageHandler = handler;
        },
      },
      sendMessage: async (message) => {
        calls.push({ type: "message", message });
      },
    },
    offscreen: {
      createDocument: async (options) => {
        calls.push({ type: "create-offscreen", options });
      },
      closeDocument: async () => {
        calls.push({ type: "close-offscreen" });
      },
    },
    sidePanel: {
      setOptions: async (options) => {
        calls.push({ type: "set-side-panel", options });
      },
      open: async (options) => {
        calls.push({ type: "open-side-panel", options });
      },
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...localStorage }),
        set: async (values) => Object.assign(localStorage, values),
        remove: async (key) => { delete localStorage[key]; },
      },
      session: {
        get: async (defaults) => ({ ...defaults, ...sessionStorage }),
        set: async (values) => Object.assign(sessionStorage, values),
        remove: async (key) => { delete sessionStorage[key]; },
      },
    },
    tabCapture: {
      getMediaStreamId: async ({ targetTabId }) => {
        calls.push({ type: "get-stream-id", targetTabId });
        return `stream-${targetTabId}`;
      },
    },
    tabs: {
      create: async (options) => {
        calls.push({ type: "create-tab", options });
      },
    },
  };

  // background.js is an ES module (it imports the transcript store), so it is
  // loaded as one with the extension globals injected, the same way the side
  // panel harness does it.
  // The global stays installed after import: the module's listeners resolve
  // `chrome` when they run, which is during the test, not at import time.
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chrome });
  await import(`${pathToFileURL(join(extensionDirectory, "background.js")).href}?test=${Date.now()}${Math.random()}`);

  return {
    calls,
    localStorage,
    sessionStorage,
    getActionClickHandler: () => actionClickHandler,
    getRuntimeMessageHandler: () => runtimeMessageHandler,
    restore() {
      if (previousChrome) {
        Object.defineProperty(globalThis, "chrome", previousChrome);
      } else {
        delete globalThis.chrome;
      }
    },
  };
}

async function createSidePanelHarness() {
  let panelMessageHandler;
  const elements = new Map();
  const downloads = [];
  const rootStyleValues = new Map();
  const localStorage = {};
  const makeElement = () => {
    const listeners = new Map();
    return {
      textContent: "",
      value: "",
      checked: false,
      hidden: false,
      disabled: false,
      className: "",
      children: [],
      addEventListener(type, handler) { listeners.set(type, handler); },
      async trigger(type) { return listeners.get(type)?.({ target: this }); },
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      click() { downloads.push({ href: this.href, download: this.download }); },
      remove() {},
      scrollTop: 0,
      scrollHeight: 0,
    };
  };
  for (const id of [
    "status",
    "transcript",
    "websocketUrl",
    "stopButton",
    "copyMarkdownButton",
    "saveMarkdownButton",
    "decreaseFontButton",
    "increaseFontButton",
    "transcriptFontSizeLabel",
    "formatSelect",
    "followButton",
    "selectionBar",
    "selectionCount",
    "copySelectedButton",
    "clearSelectionButton",
    "linkFileButton",
    "unlinkFileButton",
    "fileStatus",
    "recovery",
    "recoveryText",
    "restoreButton",
    "discardButton",
    "sessionClock",
    "emptyHint",
    "pauseButton",
    "resumeButton",
    "clearScreenButton",
    "microphoneToggle",
    "microphoneStatus",
  ]) {
    elements.set(id, makeElement());
  }

  const sessionStorage = {};
  const copied = [];
  const messages = [];

  const chrome = {
    runtime: {
      onMessage: { addListener(handler) { panelMessageHandler = handler; } },
      sendMessage: async (message) => { messages.push(message); },
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...localStorage }),
        set: async (values) => Object.assign(localStorage, values),
      },
      session: {
        get: async (defaults) => ({ ...defaults, ...sessionStorage }),
        set: async (values) => Object.assign(sessionStorage, values),
        remove: async (key) => { delete sessionStorage[key]; },
      },
    },
  };
  const document = {
    body: { append() {} },
    documentElement: {
      style: {
        setProperty(name, value) { rootStyleValues.set(name, value); },
      },
    },
    getElementById: (id) => elements.get(id),
    createElement: makeElement,
    createTextNode: (text) => ({ textContent: text }),
  };
  const previous = {
    chrome: Object.getOwnPropertyDescriptor(globalThis, "chrome"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    URL: Object.getOwnPropertyDescriptor(globalThis, "URL"),
  };
  const NativeURL = globalThis.URL;
  class TestURL extends NativeURL {}
  TestURL.createObjectURL = () => "blob:test";
  TestURL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chrome });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value) => copied.push(value) } } });
  Object.defineProperty(globalThis, "URL", { configurable: true, value: TestURL });

  await import(`${pathToFileURL(join(extensionDirectory, "sidepanel.js")).href}?test=${Date.now()}`);
  await Promise.resolve();

  return {
    chrome,
    copied,
    downloads,
    elements,
    localStorage,
    messages,
    panelMessageHandler: () => panelMessageHandler,
    rootStyleValues,
    restore() {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete globalThis[key];
        }
      }
    },
  };
}

test("manifest moves tab capture out of the transient action popup", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const sidePanelHtml = readExtensionFile("sidepanel.html");

  assert.equal(
    manifest.action.default_popup,
    undefined,
    "persistent transcription must not be hosted in a Chrome action popup",
  );
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.equal(manifest.side_panel?.default_path, "sidepanel.html");
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("clipboardWrite"));
  assert.ok(!manifest.permissions.includes("downloads"));
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.match(sidePanelHtml, /id="copyMarkdownButton"/);
  assert.match(sidePanelHtml, /id="saveMarkdownButton"/);
});

test("installing the unpacked extension does not open a missing welcome page", () => {
  assert.doesNotMatch(readExtensionFile("background.js"), /welcome\.html/);
});

test("clicking the action starts capture for the clicked conference tab", async () => {
  const { calls, getActionClickHandler } = await createBackgroundHarness();
  const actionClickHandler = getActionClickHandler();

  assert.equal(
    typeof actionClickHandler,
    "function",
    "background worker must register chrome.action.onClicked",
  );

  await actionClickHandler({ id: 42, windowId: 7 });

  assert.deepEqual(plain(calls.find((call) => call.type === "get-stream-id")), {
    type: "get-stream-id",
    targetTabId: 42,
  });
  assert.deepEqual(plain(calls.find((call) => call.type === "create-offscreen")?.options), {
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the selected conference tab for local transcription.",
  });
  assert.deepEqual(plain(calls.find((call) => call.type === "message")?.message), {
    target: "offscreen",
    title: "",
    type: "start",
    withMicrophone: false,
    streamId: "stream-42",
    sourceTabId: 42,
    websocketUrl: "ws://127.0.0.1:8001/asr",
  });
  assert.deepEqual(plain(calls.find((call) => call.type === "set-side-panel")?.options), {
    tabId: 42,
    path: "sidepanel.html",
    enabled: true,
  });
  assert.deepEqual(plain(calls.find((call) => call.type === "open-side-panel")?.options), {
    tabId: 42,
  });
  assert.ok(
    calls.findIndex((call) => call.type === "open-side-panel") < calls.findIndex((call) => call.type === "get-stream-id"),
    "opening the side panel must happen in the original action-click gesture",
  );

  const streamIdCallsAfterFirstClick = calls.filter((call) => call.type === "get-stream-id").length;
  await actionClickHandler({ id: 42, windowId: 7 });
  assert.equal(
    calls.filter((call) => call.type === "get-stream-id").length,
    streamIdCallsAfterFirstClick,
    "clicking the action again for the same tab must reopen the UI without restarting capture",
  );
});

test("a capture session remains active while a transcript view reads its snapshot", async () => {
  const sessionPath = join(extensionDirectory, "capture-session.js");
  assert.ok(
    existsSync(sessionPath),
    "the offscreen document must own a separately testable capture session",
  );

  const { CaptureSession } = await import(`${pathToFileURL(sessionPath).href}?test=${Date.now()}`);
  const calls = { recorderStops: 0, trackStops: 0, outputCloses: 0 };
  const stream = {
    getTracks: () => [{ stop: () => { calls.trackStops += 1; } }],
  };
  const recorder = {
    start(milliseconds) { calls.chunkDuration = milliseconds; },
    stop() { calls.recorderStops += 1; },
  };
  const socket = {
    readyState: 1,
    sent: [],
    send(value) { this.sent.push(value); },
    close() { calls.socketCloses = (calls.socketCloses || 0) + 1; },
  };
  const updates = [];
  const session = new CaptureSession({
    createCapturedStream: async (streamId) => {
      assert.equal(streamId, "stream-42");
      return stream;
    },
    createAudioOutput: async () => ({ close: async () => { calls.outputCloses += 1; } }),
    createRecorder: () => recorder,
    createWebSocket: (url) => {
      assert.equal(url, "ws://127.0.0.1:8001/asr");
      return socket;
    },
    publish: (update) => updates.push(update),
  });

  await session.start({
    streamId: "stream-42",
    websocketUrl: "ws://127.0.0.1:8001/asr",
    sourceTabId: 42,
  });
  socket.onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });

  assert.equal(session.snapshot.state, "recording");
  assert.equal(calls.chunkDuration, 100);
  assert.equal(calls.recorderStops, 0, "reading a snapshot for a reopened panel must not stop capture");

  socket.onmessage({ data: JSON.stringify({ lines: [{ text: "тест" }] }) });
  assert.equal(session.snapshot.lastData.lines[0].text, "тест");
  assert.equal(calls.recorderStops, 0, "publishing transcript updates must not stop capture");

  await session.stop();
  assert.equal(calls.recorderStops, 1, "only an explicit Stop command stops the recorder");
  assert.equal(session.snapshot.state, "stopping");

  socket.onmessage({ data: JSON.stringify({ type: "ready_to_stop" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.snapshot.state, "idle");
  assert.equal(calls.trackStops, 1);
  assert.equal(calls.outputCloses, 1);
  assert.ok(updates.some((update) => update.type === "transcript"));
});

test("a failed final audio signal releases tab capture instead of leaving a stuck session", async () => {
  const sessionPath = join(extensionDirectory, "capture-session.js");
  const { CaptureSession } = await import(`${pathToFileURL(sessionPath).href}?stop-test=${Date.now()}`);
  const calls = { recorderStops: 0, trackStops: 0, outputCloses: 0 };
  const stream = {
    getTracks: () => [{ stop: () => { calls.trackStops += 1; } }],
  };
  const recorder = {
    start() {},
    stop() { calls.recorderStops += 1; },
  };
  const socket = {
    readyState: 1,
    send() { throw new Error("connection closed"); },
    close() {},
  };
  const session = new CaptureSession({
    createCapturedStream: async () => stream,
    createAudioOutput: async () => ({ close: async () => { calls.outputCloses += 1; } }),
    createRecorder: () => recorder,
    createWebSocket: () => socket,
    publish: () => {},
  });

  await session.start({ streamId: "stream-42", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 42 });
  socket.onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });

  await session.stop();

  assert.equal(session.snapshot.state, "idle");
  assert.equal(calls.recorderStops, 1);
  assert.equal(calls.trackStops, 1);
  assert.equal(calls.outputCloses, 1);
});

test("a new capture snapshot clears the previous meeting text from the side panel", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();
    panelMessageHandler({
      target: "ui",
      type: "transcript",
      data: {
        lines: [{ start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "прошлая встреча" }],
      },
    });
    // Live updates are coalesced into one frame instead of redrawing 20x/s.
    await settleRender();
    assert.equal(harness.elements.get("transcript").children.length, 1);

    panelMessageHandler({
      target: "ui",
      type: "session-state",
      snapshot: { state: "connecting", status: "Новая встреча", lastData: null },
    });

    assert.equal(harness.elements.get("transcript").children.length, 0);
  } finally {
    harness.restore();
  }
});

test("clearing the screen drops what was said and keeps only what follows", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();
    const transcript = harness.elements.get("transcript");
    const textOf = (row) => row.children[1].textContent;

    // The server keeps ONE line open until it hears a five-second pause and
    // appends everything said afterwards to it, so its start never moves.
    panelMessageHandler({
      target: "ui",
      type: "transcript",
      data: { lines: [{ start: "0:00:00.00", end: "0:00:04.00", speaker: 1, text: "Первая часть." }] },
    });
    await settleRender();
    assert.equal(transcript.children.length, 1);

    await harness.elements.get("clearScreenButton").trigger("click");
    await settleRender();
    assert.equal(transcript.children.length, 0, "clearing empties the screen");

    // Same line, now longer: the user carried on talking.
    panelMessageHandler({
      target: "ui",
      type: "transcript",
      data: { lines: [{ start: "0:00:00.00", end: "0:00:10.00", speaker: 1, text: "Первая часть. Вторая часть." }] },
    });
    await settleRender();

    assert.equal(transcript.children.length, 1, "speech that continues must still reach the screen");
    assert.equal(textOf(transcript.children[0]), "Вторая часть.", "cleared text must not come back with it");
  } finally {
    harness.restore();
  }
});

test("a brand new line after clearing is shown in full", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();
    const transcript = harness.elements.get("transcript");

    panelMessageHandler({
      target: "ui",
      type: "transcript",
      data: { lines: [{ start: "0:00:00.00", end: "0:00:04.00", speaker: 1, text: "Старое." }] },
    });
    await settleRender();
    await harness.elements.get("clearScreenButton").trigger("click");
    await settleRender();

    panelMessageHandler({
      target: "ui",
      type: "transcript",
      data: {
        lines: [
          { start: "0:00:00.00", end: "0:00:04.00", speaker: 1, text: "Старое." },
          { start: "0:00:20.00", end: "0:00:24.00", speaker: 1, text: "Новое после очистки." },
        ],
      },
    });
    await settleRender();

    assert.equal(transcript.children.length, 1, "only the new line belongs on screen");
    assert.equal(transcript.children[0].children[1].textContent, "Новое после очистки.");
  } finally {
    harness.restore();
  }
});

test("the panel lets go of the file when the meeting that owned it ends", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();

    // The offscreen document reports the file attached during the meeting...
    panelMessageHandler({ target: "ui", type: "file-status", status: { attached: true, error: null } });
    await settleRender();

    // ...and then releases it when the session ends. If the panel kept its own
    // handle here, the NEXT capture would rewrite this meeting's .md from
    // scratch on every server update.
    panelMessageHandler({ target: "ui", type: "file-released" });
    await settleRender();

    assert.equal(
      harness.elements.get("linkFileButton").hidden,
      false,
      "with no file linked, the panel must offer to link one again",
    );
    assert.equal(harness.elements.get("unlinkFileButton").hidden, true);
    assert.match(harness.elements.get("fileStatus").textContent, /отвязан/i);
  } finally {
    harness.restore();
  }
});

test("the microphone can be asked for while a capture is already running", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();
    panelMessageHandler({
      target: "ui",
      type: "session-state",
      snapshot: { state: "recording", status: "Идёт запись", lastData: null },
    });

    const toggle = harness.elements.get("microphoneToggle");
    assert.equal(toggle.disabled, false, "a running capture must not lock the user out of the microphone");

    toggle.checked = true;
    await toggle.trigger("change");
    await settleRender();

    assert.equal(harness.localStorage.recordMicrophone, true, "the preference must be remembered");
    assert.ok(
      harness.messages.some((message) => message.type === "request-microphone"),
      "ticking the box must open the one-off permission page",
    );
  } finally {
    harness.restore();
  }
});

test("the side panel copies the complete local meeting archive as Markdown", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();
    panelMessageHandler({
      target: "ui",
      type: "session-state",
      snapshot: {
        state: "idle",
        status: "Встреча завершена",
        lastData: null,
        transcript: {
          schemaVersion: 1,
          startedAt: "2026-08-16T09:00:00.000Z",
          endedAt: "2026-08-16T10:00:00.000Z",
          finalized: true,
          bufferTranscription: "",
          lines: [
            { start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Начало встречи" },
            { start: "01:00:01.00", end: "01:00:02.00", speaker: 2, text: "Итог встречи" },
          ],
        },
      },
    });

    await harness.elements.get("copyMarkdownButton").trigger("click");

    assert.equal(harness.copied.length, 1);
    assert.match(harness.copied[0], /# Стенограмма видеоконференции/);
    assert.match(harness.copied[0], /Начало встречи/);
    assert.match(harness.copied[0], /Итог встречи/);
    assert.match(harness.copied[0], /Финализировано сервером/);
  } finally {
    harness.restore();
  }
});

test("the side panel saves the local archive as a Markdown download", async () => {
  const harness = await createSidePanelHarness();
  try {
    const panelMessageHandler = harness.panelMessageHandler();
    panelMessageHandler({
      target: "ui",
      type: "session-state",
      snapshot: {
        state: "idle",
        status: "Встреча завершена",
        lastData: null,
        transcript: {
          schemaVersion: 1,
          startedAt: "2026-08-16T09:00:00.000Z",
          endedAt: "2026-08-16T10:00:00.000Z",
          finalized: true,
          bufferTranscription: "",
          lines: [{ start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Сохранить меня" }],
        },
      },
    });

    await harness.elements.get("saveMarkdownButton").trigger("click");

    // The name is built from local wall-clock time, so derive the expectation
    // the same way rather than hard-coding one timezone's answer.
    const endedAt = new Date("2026-08-16T10:00:00.000Z");
    const pad = (number) => String(number).padStart(2, "0");
    const expected = `${endedAt.getFullYear()}-${pad(endedAt.getMonth() + 1)}-${pad(endedAt.getDate())}`
      + ` ${pad(endedAt.getHours())}-${pad(endedAt.getMinutes())} стенограмма.md`;

    assert.deepEqual(harness.downloads, [{ href: "blob:test", download: expected }]);
  } finally {
    harness.restore();
  }
});

test("ending the conference tab audio finalizes the offscreen capture session", async () => {
  const sessionPath = join(extensionDirectory, "capture-session.js");
  const { CaptureSession } = await import(`${pathToFileURL(sessionPath).href}?ended-track-test=${Date.now()}`);
  let endedHandler;
  const calls = { recorderStops: 0, trackStops: 0, outputCloses: 0 };
  const audioTrack = {
    addEventListener(event, handler) {
      if (event === "ended") {
        endedHandler = handler;
      }
    },
    stop() { calls.trackStops += 1; },
  };
  const stream = {
    getTracks: () => [audioTrack],
    getAudioTracks: () => [audioTrack],
  };
  const recorder = { start() {}, stop() { calls.recorderStops += 1; } };
  const socket = { readyState: 1, send() {}, close() {} };
  const session = new CaptureSession({
    createCapturedStream: async () => stream,
    createAudioOutput: async () => ({ close: async () => { calls.outputCloses += 1; } }),
    createRecorder: () => recorder,
    createWebSocket: () => socket,
    publish: () => {},
  });

  await session.start({ streamId: "stream-42", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 42 });
  socket.onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });

  assert.equal(typeof endedHandler, "function", "tab audio tracks must be observed for unexpected end");
  endedHandler();

  assert.equal(calls.recorderStops, 1);
  assert.equal(session.snapshot.state, "stopping");
  socket.onmessage({ data: JSON.stringify({ type: "ready_to_stop" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.snapshot.state, "idle");
  assert.equal(calls.outputCloses, 1);
});

test("capture session exposes a full committed archive independently of server retention", async () => {
  const sessionPath = join(extensionDirectory, "capture-session.js");
  const { CaptureSession } = await import(`${pathToFileURL(sessionPath).href}?archive-test=${Date.now()}`);
  const stream = { getTracks: () => [] };
  const recorder = { start() {}, stop() {} };
  const socket = { readyState: 1, send() {}, close() {} };
  const completedSnapshots = [];
  const session = new CaptureSession({
    createCapturedStream: async () => stream,
    createAudioOutput: async () => ({ close: async () => {} }),
    createRecorder: () => recorder,
    createWebSocket: () => socket,
    publish: () => {},
    onEnded: async (snapshot) => completedSnapshots.push(snapshot),
  });

  await session.start({ streamId: "stream-42", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 42 });
  socket.onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });
  socket.onmessage({
    data: JSON.stringify({
      lines: [{ start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Начало встречи" }],
    }),
  });
  socket.onmessage({
    data: JSON.stringify({
      lines: [{ start: "00:05:01.00", end: "00:05:02.00", speaker: 2, text: "Поздняя реплика" }],
    }),
  });

  assert.ok(session.snapshot.transcript, "session snapshot must expose the local export archive");
  assert.deepEqual(session.snapshot.transcript.lines, [
    { start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Начало встречи" },
    { start: "00:05:01.00", end: "00:05:02.00", speaker: 2, text: "Поздняя реплика" },
  ]);

  await session.stop();
  socket.onmessage({ data: JSON.stringify({ type: "ready_to_stop" }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completedSnapshots.length, 1);
  assert.equal(completedSnapshots[0].finalized, true);
  assert.equal(completedSnapshots[0].lines.length, 2);
});

test("background keeps the retained transcript when a new capture starts", async () => {
  const { getRuntimeMessageHandler, sessionStorage } = await createBackgroundHarness();
  const runtimeMessageHandler = getRuntimeMessageHandler();
  const previous = { lines: [{ text: "Предыдущая встреча" }] };
  sessionStorage.lastTranscript = previous;

  runtimeMessageHandler({ target: "background", type: "session-started" });
  await new Promise((resolve) => setImmediate(resolve));

  // A capture starting is not evidence the previous meeting was exported.
  assert.deepEqual(plain(sessionStorage.lastTranscript), plain(previous));
});

test("a transcript handed over on tab switch is stored without ending the new session", async () => {
  const { calls, getRuntimeMessageHandler, sessionStorage } = await createBackgroundHarness();
  const runtimeMessageHandler = getRuntimeMessageHandler();
  const carried = {
    schemaVersion: 1,
    finalized: false,
    lines: [{ start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Час работы" }],
  };
  sessionStorage.activeCaptureTabId = 7;

  runtimeMessageHandler({
    target: "background",
    type: "transcript-preempted",
    completedTranscript: carried,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(plain(sessionStorage.lastTranscript), carried);
  assert.equal(sessionStorage.activeCaptureTabId, 7, "the replacement capture must keep its tab registration");
  assert.ok(
    !calls.some((call) => call.type === "close-offscreen"),
    "the offscreen document the new capture needs must stay open",
  );
});

test("starting a capture over a running one hands the transcript over before clearing it", async () => {
  const sessionPath = join(extensionDirectory, "capture-session.js");
  const { CaptureSession } = await import(`${pathToFileURL(sessionPath).href}?preempt-test=${Date.now()}`);
  const stream = { getTracks: () => [] };
  const recorder = { start() {}, stop() {} };
  const sockets = [];
  const preempted = [];
  const session = new CaptureSession({
    createCapturedStream: async () => stream,
    createAudioOutput: async () => ({ close: async () => {} }),
    createRecorder: () => recorder,
    createWebSocket: () => {
      const socket = { readyState: 1, send() {}, close() {} };
      sockets.push(socket);
      return socket;
    },
    publish: () => {},
    onPreempted: async (snapshot) => { preempted.push(snapshot); },
  });

  await session.start({ streamId: "stream-42", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 42 });
  sockets[0].onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });
  sockets[0].onmessage({
    data: JSON.stringify({
      lines: [{ start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Час работы" }],
    }),
  });

  // The user clicks the extension icon on a different tab.
  await session.start({ streamId: "stream-99", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 99 });

  assert.equal(preempted.length, 1, "the outgoing transcript must be handed over exactly once");
  assert.equal(preempted[0].lines.length, 1);
  assert.equal(preempted[0].lines[0].text, "Час работы");
  assert.deepEqual(session.snapshot.transcript.lines, [], "the replacement session starts from an empty archive");
});

test("background persists the finalized transcript before closing the offscreen document", async () => {
  const { calls, getRuntimeMessageHandler, sessionStorage } = await createBackgroundHarness();
  const runtimeMessageHandler = getRuntimeMessageHandler();
  const completedTranscript = {
    schemaVersion: 1,
    finalized: true,
    lines: [{ start: "00:00:01.00", end: "00:00:02.00", speaker: 1, text: "Итог встречи" }],
  };
  sessionStorage.activeCaptureTabId = 42;

  runtimeMessageHandler({
    target: "background",
    type: "session-ended",
    completedTranscript,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(plain(sessionStorage.lastTranscript), completedTranscript);
  assert.equal(sessionStorage.activeCaptureTabId, undefined);
  assert.ok(calls.some((call) => call.type === "close-offscreen"));
});

test("offscreen delegates lifecycle storage to the background worker", () => {
  const offscreenSource = readExtensionFile("offscreen.js");

  assert.doesNotMatch(offscreenSource, /chrome\.storage\.session/);
  assert.match(offscreenSource, /type: "session-started"/);
  assert.match(offscreenSource, /type: "session-ended"/);
  assert.match(offscreenSource, /completedTranscript/);
});

test("side panel lets the reader enlarge and reduce the transcript font", async () => {
  const harness = await createSidePanelHarness();
  try {
    const increaseButton = harness.elements.get("increaseFontButton");
    const decreaseButton = harness.elements.get("decreaseFontButton");

    assert.equal(harness.rootStyleValues.get("--transcript-font-size"), "18px");
    assert.equal(increaseButton.disabled, false);
    assert.equal(decreaseButton.disabled, false);

    await increaseButton.trigger("click");
    assert.equal(harness.rootStyleValues.get("--transcript-font-size"), "20px");
    assert.equal(harness.localStorage.transcriptFontSize, 20);
    assert.match(harness.elements.get("transcriptFontSizeLabel").textContent, /20/);

    await decreaseButton.trigger("click");
    assert.equal(harness.rootStyleValues.get("--transcript-font-size"), "18px");
    assert.equal(harness.localStorage.transcriptFontSize, 18);
  } finally {
    harness.restore();
  }
});
