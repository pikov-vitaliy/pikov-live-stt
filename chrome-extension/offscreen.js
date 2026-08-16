import { CaptureSession } from "./capture-session.js";
import { formatTranscriptMarkdown } from "./transcript-archive.js";
import { TranscriptFileWriter, forgetFileHandle } from "./transcript-file-writer.js";

function createCapturedStream(streamId) {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
            },
        },
        video: false,
    });
}

/**
 * Echo cancellation matters when the meeting is played through speakers: the
 * microphone would otherwise pick the other participants up a second time and
 * their words would land in the transcript twice. On headphones it costs
 * nothing.
 */
const MICROPHONE_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
};

async function createMicrophoneStream(overrides = {}) {
    return navigator.mediaDevices.getUserMedia({
        audio: { ...MICROPHONE_CONSTRAINTS, ...overrides },
        video: false,
    });
}

/**
 * Build what the recorder listens to.
 *
 * Two different destinations, and the difference is the whole point:
 *  - the speakers get the tab only, so the user hears the meeting as usual and
 *    is NOT played back to themselves;
 *  - the recorder gets tab + microphone mixed, so the transcript finally
 *    contains the user's own half of the conversation.
 */
async function createAudioOutput(tabStream, microphoneStream) {
    const audioContext = new AudioContext();
    const mixed = audioContext.createMediaStreamDestination();
    const sources = [];

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    sources.push(tabSource);
    tabSource.connect(audioContext.destination);

    // One master gain on the RECORDER leg only. Muting it feeds the server
    // digital silence while the speakers keep playing the tab as usual — that
    // is what makes a pause both inaudible to the server and invisible to the
    // person watching.
    const captureGain = audioContext.createGain();
    captureGain.gain.value = 1;
    captureGain.connect(mixed);

    // Gain staging. Two sources summed at unity clip the moment both are loud,
    // and clipped audio wrecks recognition: the recogniser's hypotheses stop
    // agreeing, so nothing is ever committed and the text just churns in the
    // buffer. With one source, leave the level exactly as it was before.
    const level = microphoneStream ? 0.7 : 1;

    const tabGain = audioContext.createGain();
    tabGain.gain.value = level;
    tabSource.connect(tabGain).connect(captureGain);

    let microphoneGain = null;
    if (microphoneStream) {
        const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
        sources.push(microphoneSource);
        microphoneGain = audioContext.createGain();
        microphoneGain.gain.value = level;
        microphoneSource.connect(microphoneGain).connect(captureGain);
    }

    // A limiter behind them catches whatever still peaks, so a loud moment is
    // squeezed rather than squared off.
    const limiter = audioContext.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    captureGain.disconnect();
    captureGain.connect(limiter).connect(mixed);

    return {
        stream: mixed.stream,
        setCaptureMuted(muted) {
            captureGain.gain.value = muted ? 0 : 1;
        },
        setMicrophoneGain(value) {
            if (microphoneGain) {
                microphoneGain.gain.value = value;
            }
        },
        async close() {
            for (const source of sources) {
                try {
                    source.disconnect();
                } catch {
                    // Already detached.
                }
            }
            if (audioContext.state !== "closed") {
                await audioContext.close();
            }
        },
    };
}

function createRecorder(stream) {
    try {
        return new MediaRecorder(stream, { mimeType: "audio/webm" });
    } catch {
        return new MediaRecorder(stream);
    }
}

/**
 * Send a runtime message without ever letting the result escape as an uncaught
 * rejection. Browsers differ here: a missing receiver rejects in Chrome, and a
 * hardened build can throw synchronously or hand back something that is not a
 * promise at all. None of that should be able to take a capture down.
 */
async function send(message) {
    try {
        const result = chrome.runtime.sendMessage(message);
        return result && typeof result.then === "function" ? await result : result;
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function publishToPanel(update) {
    void send({ target: "ui", ...update });
}

function notifyBackground(message) {
    return send({ target: "background", ...message });
}

const fileWriter = new TranscriptFileWriter();
let fileStatus = { attached: false, error: null };

function publishFileStatus() {
    publishToPanel({ type: "file-status", status: { ...fileStatus } });
}

async function attachLiveFile() {
    try {
        const attached = await fileWriter.attach();
        fileStatus = { attached, error: attached ? null : "Файл для живой записи не выбран." };
    } catch (error) {
        // The File System Access API is a web API rather than an extension API,
        // but offscreen documents are a restricted context; if it is unavailable
        // here the side panel takes the writing over while it is open.
        fileStatus = {
            attached: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    publishFileStatus();
    return fileStatus.attached;
}

async function flushLiveFile(snapshot) {
    if (!fileWriter.isAttached || !snapshot) {
        return;
    }
    const markdown = formatTranscriptMarkdown({
        ...snapshot,
        exportedAt: new Date(),
        format: "dialogue",
        preMerged: true,
    });
    const written = await fileWriter.flush(markdown);
    if (!written && fileWriter.lastError && fileWriter.lastError !== fileStatus.error) {
        fileStatus = { attached: true, error: fileWriter.lastError };
        publishFileStatus();
    }
}

/** Detach the meeting's file and drop the stored handle. */
async function releaseLiveFile() {
    fileWriter.detach();
    fileStatus = { attached: false, error: null };
    try {
        await forgetFileHandle();
    } catch {
        // Nothing stored, or storage unavailable — either way we are detached.
    }
    publishFileStatus();
}

/** Never lets a file problem reject into the capture's promise chain. */
async function flushLiveFileSafely(snapshot) {
    try {
        await flushLiveFile(snapshot);
    } catch (error) {
        fileStatus = {
            attached: fileWriter.isAttached,
            error: error instanceof Error ? error.message : String(error),
        };
        publishFileStatus();
    }
}

const session = new CaptureSession({
    createCapturedStream,
    createAudioOutput,
    createRecorder,
    createMicrophoneStream,
    createWebSocket: (url) => new WebSocket(url),
    publish: publishToPanel,
    onEnded: async (completedTranscript) => {
        // Last write first, then release the file: it belongs to this meeting
        // and must not be inherited — and reopened — by the next one.
        await flushLiveFileSafely(completedTranscript);
        await releaseLiveFile();
        await notifyBackground({ type: "session-ended", completedTranscript });
    },
    onPreempted: async (carriedTranscript) => {
        // Store only. Tearing the session down here would kill the offscreen
        // document the replacement capture is about to use.
        await flushLiveFileSafely(carriedTranscript);
        await notifyBackground({ type: "transcript-preempted", completedTranscript: carriedTranscript });
    },
    onAutosave: async (snapshot) => {
        await notifyBackground({ type: "autosave", snapshot });
        await flushLiveFileSafely(snapshot);
    },
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") {
        return undefined;
    }

    if (message.type === "start") {
        // Deliberately NOT re-attaching a stored handle here. The handle is
        // scoped to the meeting it was chosen for; picking it up automatically
        // meant the next meeting truncated the previous meeting's .md, because
        // every flush rewrites the file in full. A new meeting starts unlinked
        // until the user picks a file for it.
        void session.start(message)
            .then(() => notifyBackground({ type: "session-started" }))
            .catch(() => {});
    } else if (message.type === "stop") {
        void session.stop();
    } else if (message.type === "pause") {
        session.pause();
    } else if (message.type === "resume") {
        session.resume({ title: message.title || "" });
    } else if (message.type === "get-state") {
        // Answer over the response channel so the panel can tell an absent
        // offscreen document from a live one, instead of guessing from whether
        // sendMessage rejected.
        sendResponse({ snapshot: session.snapshot, file: { ...fileStatus } });
        return true;
    } else if (message.type === "file-attached") {
        void attachLiveFile().then((attached) => {
            if (attached) {
                void flushLiveFileSafely(session.snapshot.transcript);
            }
        });
    } else if (message.type === "file-detached") {
        void releaseLiveFile();
    }
    return undefined;
});
