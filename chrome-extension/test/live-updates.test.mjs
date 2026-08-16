import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = dirname(testDirectory);

function load(name, tag) {
  return import(`${pathToFileURL(join(extensionDirectory, name)).href}?${tag}=${Date.now()}${Math.random()}`);
}

/** Just enough DOM for the view, plus a counter proving how much it rebuilds. */
function createFakeDocument() {
  const stats = { created: 0 };
  const createElement = () => {
    stats.created += 1;
    const node = {
      children: [],
      className: "",
      textContent: "",
      listeners: new Map(),
      parent: null,
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      dispatch(type, event = {}) { return this.listeners.get(type)?.(event); },
      append(child) { child.parent = this; this.children.push(child); },
      replaceChildren() {
        for (const child of this.children) { child.parent = null; }
        this.children = [];
      },
      remove() {
        if (!this.parent) { return; }
        this.parent.children = this.parent.children.filter((child) => child !== this);
        this.parent = null;
      },
    };
    return node;
  };
  return { documentObject: { createElement }, stats, createElement };
}

function line(startSeconds, endSeconds, text, speaker = 1) {
  const format = (value) => {
    const whole = Math.floor(value);
    return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.00`;
  };
  return { start: format(startSeconds), end: format(endSeconds), speaker, text };
}

test("re-syncing unchanged lines creates no DOM nodes at all", async () => {
  const { TranscriptView } = await load("transcript-view.js", "view");
  const { documentObject, stats, createElement } = createFakeDocument();
  const container = createElement();
  const view = new TranscriptView({ container, documentObject });

  const lines = [line(0, 4, "Первая"), line(4, 8, "Вторая")];
  view.sync(lines, "");
  const afterFirstRender = stats.created;

  for (let i = 0; i < 20; i += 1) {
    view.sync(lines, "");
  }

  assert.equal(stats.created, afterFirstRender, "an unchanged update must not touch the DOM");
  assert.equal(container.children.length, 2);
});

test("a revised line is patched in place rather than recreated", async () => {
  const { TranscriptView } = await load("transcript-view.js", "view");
  const { documentObject, stats, createElement } = createFakeDocument();
  const container = createElement();
  const view = new TranscriptView({ container, documentObject });

  view.sync([line(0, 4, "Черновик")], "");
  const node = container.children[0];
  const afterFirstRender = stats.created;

  view.sync([line(0, 6, "Исправленный текст")], "");

  assert.equal(stats.created, afterFirstRender, "revising text must not build a new node");
  assert.equal(container.children[0], node, "the element the reader may be selecting must survive");
  assert.equal(node.children[1].textContent, "Исправленный текст");
});

test("appending a line leaves the existing ones untouched", async () => {
  const { TranscriptView } = await load("transcript-view.js", "view");
  const { documentObject, createElement } = createFakeDocument();
  const container = createElement();
  const view = new TranscriptView({ container, documentObject });

  view.sync([line(0, 4, "Первая")], "");
  const first = container.children[0];

  const created = view.sync([line(0, 4, "Первая"), line(4, 8, "Вторая")], "");

  assert.equal(created, 1, "only the new line should be built");
  assert.equal(container.children[0], first);
  assert.equal(container.children.length, 2);
});

test("a window that slides past the row cap does not rebuild the whole list", async () => {
  const { TranscriptView } = await load("transcript-view.js", "view");
  const { documentObject, stats, createElement } = createFakeDocument();
  const container = createElement();
  const CAP = 10;
  const view = new TranscriptView({ container, documentObject, maxLines: CAP });

  const all = Array.from({ length: 40 }, (_, index) => line(index * 4, index * 4 + 4, `Реплика ${index}`));
  for (let count = 1; count <= CAP; count += 1) {
    view.sync(all.slice(0, count), "");
  }
  const afterFilling = stats.created;

  // From here the caller feeds a sliding tail, exactly as renderNow does.
  for (let count = CAP + 1; count <= all.length; count += 1) {
    view.sync(all.slice(count - CAP, count), "");
  }

  const createdWhileSliding = stats.created - afterFilling;
  const perLine = createdWhileSliding / (all.length - CAP);
  assert.ok(perLine < 8, `a slid window must cost a few nodes per line, not a rebuild (got ${perLine.toFixed(1)})`);
  assert.equal(container.children.length, CAP, "the visible window keeps its size");
  assert.equal(view.rendered.size, CAP);
});

test("the buffer line stays last as committed lines arrive", async () => {
  const { TranscriptView } = await load("transcript-view.js", "view");
  const { documentObject, createElement } = createFakeDocument();
  const container = createElement();
  const view = new TranscriptView({ container, documentObject });

  view.sync([line(0, 4, "Первая")], "распознаётся…");
  assert.equal(container.children.length, 2);
  assert.equal(container.children[1].className, "line buffer");

  view.sync([line(0, 4, "Первая"), line(4, 8, "Вторая")], "ещё распознаётся…");
  assert.equal(container.children.length, 3);
  assert.equal(container.children[2].className, "line buffer", "the buffer must remain the last row");

  view.sync([line(0, 4, "Первая"), line(4, 8, "Вторая")], "");
  assert.equal(container.children.length, 2, "an empty buffer removes its row");
});

test("copying and selecting a line reach the panel", async () => {
  const { TranscriptView } = await load("transcript-view.js", "view");
  const { documentObject, createElement } = createFakeDocument();
  const container = createElement();
  const copied = [];
  const toggled = [];
  const view = new TranscriptView({
    container,
    documentObject,
    onCopyLine: (key) => copied.push(key),
    onToggleLine: (key) => toggled.push(key),
  });

  view.sync([line(0, 4, "Реплика")], "");
  const row = container.children[0];
  const copyButton = row.children[0].children[row.children[0].children.length - 1];

  copyButton.dispatch("click", {});
  row.dispatch("dblclick", {});
  row.dispatch("click", {});
  row.dispatch("click", { ctrlKey: true });

  assert.deepEqual(copied, ["0:00:00.00", "0:00:00.00"], "button and double click both copy");
  assert.deepEqual(toggled, ["0:00:00.00"], "a plain click must stay free for text selection");
});

test("the scroll pin only holds near the bottom", async () => {
  const { isPinnedToBottom } = await load("transcript-view.js", "view");

  assert.equal(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }), true);
  assert.equal(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 }), true);
  assert.equal(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 200 }), false);
});

test("timers are not called with the session as their receiver", async () => {
  // Storing `setTimeout` on the instance and calling it as `this.schedule(...)`
  // hands the browser the wrong receiver and raises "Illegal invocation".
  const { CaptureSession } = await load("capture-session.js", "timers");
  const stream = { getTracks: () => [] };
  const recorder = { start() {}, stop() {} };
  const socket = { readyState: 1, send() {}, close() {} };
  const session = new CaptureSession({
    createCapturedStream: async () => stream,
    createAudioOutput: async () => ({ close: async () => {} }),
    createRecorder: () => recorder,
    createWebSocket: () => socket,
    publish: () => {},
  });

  assert.notEqual(session.schedule, setTimeout, "the raw native timer must not be stored on the instance");
  assert.notEqual(session.cancelSchedule, clearTimeout);

  await session.start({ streamId: "s", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 1 });
  socket.onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });

  // stop() arms the finalisation timer through this.schedule(...).
  await session.stop();
  assert.equal(session.snapshot.state, "stopping");
  assert.notEqual(session.finalizationTimer, null, "the finalisation timer must actually be armed");
  session.cancelSchedule(session.finalizationTimer);
});

test("a failing autosave is reported instead of becoming an uncaught rejection", async () => {
  const { CaptureSession } = await load("capture-session.js", "autosave-failure");
  const published = [];
  const session = new CaptureSession({
    createCapturedStream: async () => ({ getTracks: () => [] }),
    createAudioOutput: async () => ({ close: async () => {} }),
    createRecorder: () => ({ start() {}, stop() {} }),
    createWebSocket: () => ({ readyState: 1, send() {}, close() {} }),
    publish: (update) => published.push(update),
    onAutosave: async () => { throw new TypeError("Illegal invocation"); },
    autosaveIntervalMs: 0,
  });

  await session.start({ streamId: "s", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 1 });
  session.archive.merge({ lines: [{ start: "0:00:01.00", end: "0:00:02.00", speaker: 1, text: "Реплика" }] });
  session.maybeAutosave({ force: true });
  await new Promise((resolve) => setImmediate(resolve));

  const failure = published.find((update) => update.type === "background-failure");
  assert.ok(failure, "the panel must be told the autosave failed");
  assert.equal(failure.what, "autosave");
  assert.match(failure.error, /Illegal invocation/);
});

function createSessionHarness(overrides = {}) {
  const calls = { recorderPauses: 0, recorderResumes: 0, tabTrackStops: 0, micTrackStops: 0, muted: [] };
  const timers = [];
  const tabTrack = { stop() { calls.tabTrackStops += 1; }, addEventListener() {} };
  const micTrack = { stop() { calls.micTrackStops += 1; }, addEventListener() {} };
  const tabStream = { getTracks: () => [tabTrack], getAudioTracks: () => [tabTrack] };
  const micStream = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  const mixedStream = { id: "mixed" };
  const recorder = {
    state: "inactive",
    recorded: null,
    start() { this.state = "recording"; },
    stop() { this.state = "inactive"; },
    pause() { calls.recorderPauses += 1; this.state = "paused"; },
    resume() { calls.recorderResumes += 1; this.state = "recording"; },
  };
  const socket = { readyState: 1, send() {}, close() {} };

  return {
    calls, tabStream, micStream, mixedStream, recorder, socket, timers,
    runTimers() { for (const t of timers.splice(0)) { t?.(); } },
    options: {
      createCapturedStream: async () => tabStream,
      createMicrophoneStream: async () => micStream,
      createAudioOutput: async (tab, mic) => ({
        stream: mic ? mixedStream : tab,
        setCaptureMuted: (muted) => calls.muted.push(muted),
        close: async () => {},
      }),
      schedule: (callback) => { timers.push(callback); return timers.length; },
      cancelSchedule: (handle) => { timers[handle - 1] = null; },
      createRecorder: (stream) => { recorder.recorded = stream; return recorder; },
      createWebSocket: () => socket,
      publish: () => {},
      ...overrides,
    },
  };
}

async function startedSession(CaptureSession, harness, startOptions = {}) {
  const session = new CaptureSession(harness.options);
  await session.start({
    streamId: "s", websocketUrl: "ws://127.0.0.1:8001/asr", sourceTabId: 1, ...startOptions,
  });
  harness.socket.onmessage({ data: JSON.stringify({ type: "config", useAudioWorklet: false }) });
  return session;
}

test("pause stops the recorder without releasing the captured tab", async () => {
  const { CaptureSession } = await load("capture-session.js", "pause");
  const harness = createSessionHarness();
  const session = await startedSession(CaptureSession, harness);

  assert.equal(session.snapshot.state, "recording");
  assert.equal(session.pause(), true);

  assert.equal(session.snapshot.state, "paused");
  assert.deepEqual(harness.calls.muted, [true], "the capture leg must be silenced at once");
  assert.equal(
    harness.calls.recorderPauses,
    0,
    "the encoder must keep running on that silence — pausing it now would send the server nothing, "
      + "and the server needs to HEAR silence to close its open line",
  );

  harness.runTimers();
  assert.equal(harness.calls.recorderPauses, 1, "only then is the recorder itself paused");
  assert.equal(harness.calls.tabTrackStops, 0, "the tab must stay captured across a pause");
  assert.equal(harness.socket.readyState, 1, "the socket must stay open");
  assert.equal(session.pause(), false, "pausing twice is a no-op");
});

test("resume restarts the recorder and opens a named segment", async () => {
  const { CaptureSession } = await load("capture-session.js", "resume");
  const harness = createSessionHarness();
  const session = await startedSession(CaptureSession, harness, { title: "Первый ролик" });

  assert.equal(session.segments.length, 1, "a session opens with one segment");
  assert.equal(session.segments[0].title, "Первый ролик");

  session.pause();
  assert.equal(session.resume({ title: "Второй ролик" }), true);

  assert.equal(session.snapshot.state, "recording");
  assert.equal(harness.calls.recorderResumes, 1);
  assert.equal(session.segments.length, 2, "each resume opens a segment");
  assert.equal(session.segments[1].title, "Второй ролик");
  assert.equal(session.exportSnapshot().segments.length, 2, "segments travel with the snapshot");
  assert.equal(session.resume(), false, "resuming while recording is a no-op");
});

test("the microphone is mixed into what gets recorded and released at the end", async () => {
  const { CaptureSession } = await load("capture-session.js", "mic");
  const harness = createSessionHarness();
  const session = await startedSession(CaptureSession, harness, { withMicrophone: true });

  assert.equal(harness.recorder.recorded, harness.mixedStream, "the recorder must take the mixed stream");
  assert.equal(session.snapshot.diagnostics.microphoneActive, true);

  await session.finish("done", false);
  assert.equal(harness.calls.micTrackStops, 1, "the microphone must be released or its indicator stays on");
  assert.equal(harness.calls.tabTrackStops, 1);
});

test("pausing also silences the microphone, and resuming brings it back", async () => {
  const { CaptureSession } = await load("capture-session.js", "mic-pause");
  const harness = createSessionHarness();
  const micTrack = harness.micStream.getAudioTracks()[0];
  micTrack.enabled = true;

  const session = await startedSession(CaptureSession, harness, { withMicrophone: true });
  assert.equal(micTrack.enabled, true);

  session.pause();
  assert.equal(micTrack.enabled, false, "on pause nothing of the user's must be capturable");
  assert.equal(session.snapshot.diagnostics.microphoneActive, false);

  session.resume();
  assert.equal(micTrack.enabled, true);
  assert.equal(session.snapshot.diagnostics.microphoneActive, true);
});

test("without the microphone only tab audio is recorded", async () => {
  const { CaptureSession } = await load("capture-session.js", "no-mic");
  const harness = createSessionHarness();
  const session = await startedSession(CaptureSession, harness, { withMicrophone: false });

  assert.equal(harness.recorder.recorded, harness.tabStream);
  assert.equal(session.snapshot.diagnostics.microphoneActive, false);
});

test("a refused microphone downgrades to tab audio instead of losing the meeting", async () => {
  const { CaptureSession } = await load("capture-session.js", "mic-refused");
  const published = [];
  const harness = createSessionHarness({
    createMicrophoneStream: async () => { throw new Error("NotAllowedError"); },
    publish: (update) => published.push(update),
  });
  const session = await startedSession(CaptureSession, harness, { withMicrophone: true });

  assert.equal(session.snapshot.state, "recording", "the capture must carry on");
  assert.equal(session.snapshot.diagnostics.microphoneActive, false);
  const failure = published.find((update) => update.type === "background-failure" && update.what === "microphone");
  assert.ok(failure, "the panel must be told the microphone was unavailable");
});

test("the offscreen document's module graph loads", async () => {
  // Nothing else imports offscreen.js, so a broken import path or a renamed
  // export would otherwise only show up as a dead extension in the browser.
  const stubs = {
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } },
    navigator: { mediaDevices: {} },
    AudioContext: class {},
    MediaRecorder: class {},
    WebSocket: class {},
  };
  const previous = Object.fromEntries(
    Object.keys(stubs).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }

  try {
    const module = await load("offscreen.js", "offscreen");
    assert.ok(module, "offscreen.js must load with its dependencies");
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
});

// ---------------------------------------------------------------------------

function createFakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (defaults) => ({ ...defaults, ...data }),
    set: async (values) => Object.assign(data, values),
  };
}

test("autosave keeps one record per session and survives repeated writes", async () => {
  const { TranscriptStore, SESSIONS_KEY } = await load("transcript-store.js", "store");
  const storage = createFakeStorage();
  const store = new TranscriptStore({ storage, now: () => 1_000_000 });

  await store.save("s1", { lines: [{ text: "первая версия" }] }, { title: "Планёрка" });
  await store.save("s1", { lines: [{ text: "первая версия" }, { text: "вторая" }] }, { title: "Планёрка" });
  await store.save("s2", { lines: [{ text: "другая встреча" }] });

  const sessions = storage.data[SESSIONS_KEY];
  assert.equal(sessions.length, 2, "re-saving a session must replace it, not append");
  assert.equal(sessions.find((session) => session.id === "s1").snapshot.lines.length, 2);
  assert.equal(sessions.find((session) => session.id === "s1").summary.lineCount, 2);
});

test("transcripts older than the retention window are dropped", async () => {
  const { TranscriptStore } = await load("transcript-store.js", "store");
  const day = 24 * 60 * 60 * 1000;
  let clock = 0;
  const storage = createFakeStorage();
  const store = new TranscriptStore({ storage, now: () => clock, retentionDays: 7 });

  clock = 10 * day;
  await store.save("old", { lines: [{ text: "старое" }] });
  clock = 20 * day;
  await store.save("fresh", { lines: [{ text: "свежее" }] });

  const sessions = await store.list();
  assert.deepEqual(sessions.map((session) => session.id), ["fresh"]);
});

test("an interrupted session is offered for recovery, a finished one is not", async () => {
  const { TranscriptStore } = await load("transcript-store.js", "store");
  const storage = createFakeStorage();
  let clock = 1_000_000;
  const store = new TranscriptStore({ storage, now: () => (clock += 1000) });

  await store.save("done", { lines: [{ text: "готово" }] }, { finalized: true });
  await store.save("crashed", { lines: [{ text: "оборвалось" }] }, { finalized: false });

  assert.equal((await store.latestUnfinished()).id, "crashed");
  await store.remove("crashed");
  assert.equal(await store.latestUnfinished(), null);
});

// ---------------------------------------------------------------------------

test("the live file is rewritten only when its contents actually change", async () => {
  const { TranscriptFileWriter } = await load("transcript-file-writer.js", "writer");
  const written = [];
  const handle = { queryPermission: async () => "granted" };
  const writer = new TranscriptFileWriter({
    loadHandle: async () => handle,
    write: async (_handle, contents) => { written.push(contents); },
  });

  assert.equal(await writer.attach(), true);
  assert.equal(await writer.flush("первая версия"), true);
  assert.equal(await writer.flush("первая версия"), false, "an identical flush must not rewrite the file");
  assert.equal(await writer.flush("вторая версия"), true);

  assert.deepEqual(written, ["первая версия", "вторая версия"]);
});

test("a revoked write permission is reported instead of throwing", async () => {
  const { TranscriptFileWriter } = await load("transcript-file-writer.js", "writer");
  const handle = { queryPermission: async () => "prompt" };
  const writer = new TranscriptFileWriter({
    loadHandle: async () => handle,
    write: async () => { throw new Error("должно быть недостижимо"); },
  });

  await writer.attach();
  assert.equal(await writer.flush("текст"), false);
  assert.match(writer.lastError, /разрешени/i);
});

test("a failing write surfaces its error and does not wedge later writes", async () => {
  const { TranscriptFileWriter } = await load("transcript-file-writer.js", "writer");
  let failNext = true;
  const handle = { queryPermission: async () => "granted" };
  const writer = new TranscriptFileWriter({
    loadHandle: async () => handle,
    write: async () => {
      if (failNext) {
        failNext = false;
        throw new Error("диск недоступен");
      }
    },
  });

  await writer.attach();
  assert.equal(await writer.flush("первая"), false);
  assert.match(writer.lastError, /диск недоступен/);
  assert.equal(await writer.flush("вторая"), true, "the writer must recover for the next flush");
  assert.equal(writer.lastError, null);
});
