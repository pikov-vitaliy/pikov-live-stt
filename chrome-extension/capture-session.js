import { TranscriptArchive } from "./transcript-archive.js";

const SOCKET_OPEN = 1;

/**
 * Owns a single tab-capture session.  It deliberately has no UI lifecycle:
 * a side panel may be opened or closed without changing this session.
 */
export class CaptureSession {
    constructor({
        createCapturedStream,
        createAudioOutput,
        createRecorder,
        createWebSocket,
        // Optional: the user's own microphone. Tab capture only carries what
        // the page plays back, so without this the user is the one participant
        // missing from every transcript.
        createMicrophoneStream = async () => null,
        publish,
        onEnded = () => {},
        onPreempted = () => {},
        onAutosave = () => {},
        chunkDuration = 100,
        finalizationTimeoutMs = 15_000,
        autosaveIntervalMs = 15_000,
        // Long enough for the server to call it real silence and close the open
        // line (its threshold is 5 s of audio time), short enough to be over
        // before the user presses Продолжить.
        silenceBeforePauseMs = 6_500,
        now = () => Date.now(),
        // Wrapped rather than passed by reference: storing a native function on
        // an object and calling it as `this.schedule(...)` hands it the wrong
        // receiver, and the browser answers with "Illegal invocation".
        schedule = (callback, delay) => setTimeout(callback, delay),
        cancelSchedule = (handle) => clearTimeout(handle),
    }) {
        this.createCapturedStream = createCapturedStream;
        this.createAudioOutput = createAudioOutput;
        this.createRecorder = createRecorder;
        this.createWebSocket = createWebSocket;
        this.createMicrophoneStream = createMicrophoneStream;
        this.publish = publish;
        this.onEnded = onEnded;
        this.onPreempted = onPreempted;
        this.onAutosave = onAutosave;
        this.chunkDuration = chunkDuration;
        this.finalizationTimeoutMs = finalizationTimeoutMs;
        this.autosaveIntervalMs = autosaveIntervalMs;
        this.silenceBeforePauseMs = silenceBeforePauseMs;
        this.pauseTimer = null;
        this.now = now;
        this.schedule = schedule;
        this.cancelSchedule = cancelSchedule;

        this.sessionId = null;
        this.title = "";
        this.lastAutosaveAt = 0;
        this.lastAutosaveSignature = null;

        // Diagnostics: without these an empty transcript is indistinguishable
        // from a silent tab, a dead socket and a broken renderer.
        this.chunksSent = 0;
        this.bytesSent = 0;
        this.updatesReceived = 0;
        this.serverStatus = "";
        this.segments = [];

        this.state = "idle";
        this.status = "Ready. Click the extension icon in the conference tab to start.";
        this.sourceTabId = null;
        this.lastData = null;
        this.archive = new TranscriptArchive();
        this.startedAt = null;
        this.endedAt = null;
        this.finalized = false;
        this.stream = null;
        this.microphoneStream = null;
        this.microphoneActive = false;
        this.audioOutput = null;
        this.recorder = null;
        this.socket = null;
        this.finalizationTimer = null;
    }

    get snapshot() {
        return {
            state: this.state,
            status: this.status,
            sourceTabId: this.sourceTabId,
            lastData: this.lastData,
            transcript: this.exportSnapshot(),
            diagnostics: {
                chunksSent: this.chunksSent,
                bytesSent: this.bytesSent,
                updatesReceived: this.updatesReceived,
                serverStatus: this.serverStatus,
                socketOpen: this.socket?.readyState === SOCKET_OPEN,
                recording: Boolean(this.recorder),
                microphoneActive: this.microphoneActive,
            },
        };
    }

    exportSnapshot() {
        return {
            schemaVersion: 1,
            sessionId: this.sessionId,
            title: this.title,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            finalized: this.finalized,
            segments: this.segments.map((segment) => ({ ...segment })),
            lines: this.archive.lines,
            bufferTranscription: this.finalized ? "" : String(this.lastData?.buffer_transcription || ""),
        };
    }

    /**
     * Hand the running transcript over for durable storage. Throttled, because
     * the server pushes an update about twenty times a second, and skipped
     * entirely when nothing new has been committed since the last save.
     */
    maybeAutosave({ force = false } = {}) {
        const signature = `${this.archive.size}:${this.archive.entries[this.archive.entries.length - 1]?.text?.length || 0}`;
        const due = this.now() - this.lastAutosaveAt >= this.autosaveIntervalMs;

        if (!force && (!due || signature === this.lastAutosaveSignature)) {
            return false;
        }
        if (!this.archive.size) {
            return false;
        }

        this.lastAutosaveAt = this.now();
        this.lastAutosaveSignature = signature;
        try {
            // Autosave must never interrupt the capture it is protecting — but
            // it must not fail silently either, or a browser-specific failure
            // surfaces only as an anonymous uncaught rejection in the console.
            const pending = this.onAutosave(this.exportSnapshot());
            if (pending && typeof pending.catch === "function") {
                pending.catch((error) => this.reportBackgroundFailure("autosave", error));
            }
        } catch (error) {
            this.reportBackgroundFailure("autosave", error);
        }
        return true;
    }

    reportBackgroundFailure(what, error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
            this.publish({ type: "background-failure", what, error: detail });
        } catch {
            // Reporting a failure must not itself take the session down.
        }
    }

    async start({ streamId, websocketUrl, sourceTabId, title = "", sessionId = null, withMicrophone = false }) {
        if (this.state !== "idle") {
            // Switching tabs must never be the one path that throws a meeting
            // away: hand the outgoing transcript over for safekeeping before
            // anything is torn down or cleared.
            if (this.archive.size > 0) {
                try {
                    this.endedAt = this.endedAt || new Date().toISOString();
                    await this.onPreempted(this.exportSnapshot());
                } catch {
                    // Losing the carried copy must not also block the new session.
                }
            }
            await this.finish("Restarting transcription for another tab.", false);
        }

        this.sourceTabId = sourceTabId;
        this.title = String(title || "");
        this.sessionId = sessionId || `session-${this.now()}`;
        this.lastData = null;
        this.archive.clear();
        this.startedAt = new Date().toISOString();
        this.endedAt = null;
        this.finalized = false;
        this.lastAutosaveAt = 0;
        this.lastAutosaveSignature = null;
        this.chunksSent = 0;
        this.bytesSent = 0;
        this.updatesReceived = 0;
        this.serverStatus = "";
        this.segments = [];
        this.microphoneActive = false;
        this.state = "connecting";
        this.status = "Capturing conference tab audio…";
        this.publishState();

        try {
            this.stream = await this.createCapturedStream(streamId);
            this.watchCapturedTracks(this.stream);

            if (withMicrophone) {
                try {
                    this.microphoneStream = await this.createMicrophoneStream();
                    this.microphoneActive = Boolean(this.microphoneStream);
                } catch (error) {
                    // A refused or unavailable microphone must not cost the
                    // meeting: carry on with tab audio and report it.
                    this.microphoneStream = null;
                    this.microphoneActive = false;
                    this.reportBackgroundFailure("microphone", error);
                }
            }

            // The output bundle mixes tab audio with the microphone for the
            // recorder while sending only tab audio to the speakers — routing
            // the microphone there would play the user back to themselves.
            this.audioOutput = await this.createAudioOutput(this.stream, this.microphoneStream);
            this.openSegment(this.title);
            const socket = this.createWebSocket(websocketUrl);
            this.socket = socket;
            socket.binaryType = "arraybuffer";
            socket.onopen = () => {
                if (this.socket !== socket) {
                    return;
                }
                this.status = "Connected. Waiting for the transcription server…";
                this.publishState();
            };
            socket.onmessage = (event) => {
                if (this.socket === socket) {
                    this.handleServerMessage(event);
                }
            };
            socket.onerror = () => {
                if (this.socket === socket && this.state !== "stopping") {
                    void this.finish("The local transcription server connection failed.");
                }
            };
            socket.onclose = () => {
                if (this.socket === socket) {
                    void this.finish(
                        this.state === "stopping"
                            ? "Transcription stopped."
                            : "The local transcription server disconnected.",
                    );
                }
            };
        } catch (error) {
            await this.finish(
                error instanceof Error ? error.message : "Could not capture conference tab audio.",
            );
            throw error;
        }
    }

    watchCapturedTracks(stream) {
        const tracks = typeof stream.getAudioTracks === "function"
            ? stream.getAudioTracks()
            : stream.getTracks();

        for (const track of tracks) {
            if (typeof track.addEventListener !== "function") {
                continue;
            }
            track.addEventListener("ended", () => {
                if (this.stream === stream && this.state !== "idle" && this.state !== "stopping") {
                    void this.stop();
                }
            }, { once: true });
        }
    }

    handleServerMessage(event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            this.status = "The local transcription server sent an invalid response.";
            this.publishState();
            return;
        }

        if (data.type === "config") {
            if (data.useAudioWorklet) {
                void this.finish("This extension supports the WebM server mode only.");
                return;
            }
            this.startRecorder();
            return;
        }

        if (data.type === "ready_to_stop") {
            this.finalized = true;
            void this.finish("Finished processing audio.");
            return;
        }

        this.updatesReceived += 1;
        this.serverStatus = String(data.status || "");
        this.archive.merge(data);
        this.lastData = data;
        this.publish({ type: "transcript", data, diagnostics: this.snapshot.diagnostics });
        this.maybeAutosave();
    }

    /**
     * Stop feeding the server without taking the session down: the tab stays
     * captured, the socket stays open, the file keeps what it already has.
     *
     * The recorder itself is paused rather than having its chunks discarded.
     * Dropping chunks would punch a hole in the middle of one continuous WebM
     * stream and the server could not decode past it; pausing simply stops
     * producing bytes, which a 30-second live test showed the server handles.
     */
    pause() {
        if (this.state !== "recording") {
            return false;
        }

        const recorder = this.recorder;
        if (recorder && typeof recorder.pause === "function") {
            try {
                recorder.pause();
            } catch {
                // Already paused or already finished — the state below still holds.
            }
        }

        // Silence immediately — both the recorder feed and the microphone
        // itself. From this instant nothing of the user's can be captured.
        this.audioOutput?.setCaptureMuted?.(true);
        this.setMicrophoneEnabled(false);

        // Then keep the encoder running on that silence for a moment before
        // actually pausing it. Chromium ELIDES the paused interval from the
        // container timeline, so the server would never see a gap; its rule for
        // closing a line needs more than five seconds of silence in AUDIO time
        // (audio_processor.py:26,292). Without this the line open at pause
        // swallows the first words of the next segment.
        this.pauseTimer = this.schedule(() => {
            this.pauseTimer = null;
            if (this.state !== "paused") {
                return;
            }
            const paused = this.recorder;
            if (paused && typeof paused.pause === "function") {
                try {
                    paused.pause();
                } catch {
                    // Already inactive; the silence has done its job regardless.
                }
            }
        }, this.silenceBeforePauseMs);

        this.state = "paused";
        this.status = "Пауза. Микрофон отключён, запись возобновится по кнопке «Продолжить».";
        this.publishState();
        return true;
    }

    setMicrophoneEnabled(enabled) {
        for (const track of this.microphoneStream?.getAudioTracks?.() || []) {
            track.enabled = enabled;
        }
        this.microphoneActive = Boolean(this.microphoneStream) && enabled;
    }

    /** Resume, opening a new segment so the export shows where it restarted. */
    resume({ title = "" } = {}) {
        if (this.state !== "paused") {
            return false;
        }

        if (this.pauseTimer) {
            this.cancelSchedule(this.pauseTimer);
            this.pauseTimer = null;
        }

        this.openSegment(title);
        this.setMicrophoneEnabled(true);
        this.audioOutput?.setCaptureMuted?.(false);

        const recorder = this.recorder;
        if (recorder && typeof recorder.resume === "function") {
            try {
                recorder.resume();
            } catch {
                // Nothing to resume; the recorder is restarted below if needed.
            }
        }

        this.state = "recording";
        this.status = "Transcribing tab audio locally.";
        this.publishState();
        return true;
    }

    /**
     * Mark the start of a recorded stretch. Lines are assigned to a segment by
     * the server-side time at which it opened, because the server timeline is
     * what the archive keys on.
     */
    openSegment(title) {
        const lastKnownEnd = this.archive.entries.length
            ? this.archive.entries[this.archive.entries.length - 1].end
            : "";
        this.segments.push({
            index: this.segments.length + 1,
            startedAt: new Date().toISOString(),
            title: String(title || this.title || ""),
            fromServerTime: lastKnownEnd,
        });
    }

    startRecorder() {
        if (this.recorder || this.state === "stopping") {
            return;
        }

        try {
            // Record the mixed output when there is one; fall back to the raw
            // tab stream so a caller that supplies no mixer still works.
            const recorder = this.createRecorder(this.audioOutput?.stream || this.stream);
            this.recorder = recorder;
            recorder.ondataavailable = (event) => {
                if (
                    this.socket?.readyState === SOCKET_OPEN &&
                    event.data &&
                    event.data.size > 0
                ) {
                    this.socket.send(event.data);
                    this.chunksSent += 1;
                    this.bytesSent += event.data.size;
                }
            };
            recorder.start(this.chunkDuration);
            this.state = "recording";
            this.status = "Transcribing tab audio locally.";
            this.publishState();
        } catch (error) {
            void this.finish(
                error instanceof Error ? error.message : "Could not start tab audio recording.",
            );
        }
    }

    async stop() {
        if (this.state === "idle" || this.state === "stopping") {
            return;
        }

        this.state = "stopping";
        this.status = "Stopping transcription and processing final audio…";
        this.publishState();

        const recorder = this.recorder;
        this.recorder = null;
        if (recorder) {
            try {
                recorder.stop();
            } catch {
                // A recorder can already be stopped while a final chunk is in flight.
            }
        }

        if (this.socket?.readyState === SOCKET_OPEN) {
            try {
                this.socket.send(new Blob([], { type: "audio/webm" }));
            } catch {
                await this.finish("Transcription stopped.");
                return;
            }
            this.finalizationTimer = this.schedule(() => {
                void this.finish("Stopped while waiting for final transcription.");
            }, this.finalizationTimeoutMs);
            return;
        }

        await this.finish("Transcription stopped.");
    }

    async finish(status, notifyEnded = true) {
        if (this.pauseTimer) {
            this.cancelSchedule(this.pauseTimer);
            this.pauseTimer = null;
        }
        if (this.finalizationTimer) {
            this.cancelSchedule(this.finalizationTimer);
            this.finalizationTimer = null;
        }

        const recorder = this.recorder;
        this.recorder = null;
        if (recorder) {
            try {
                recorder.stop();
            } catch {
                // Nothing to do if it has already stopped.
            }
        }

        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            try {
                socket.close();
            } catch {
                // A failed WebSocket is already closed.
            }
        }

        const stream = this.stream;
        this.stream = null;
        stream?.getTracks().forEach((track) => track.stop());

        // Release the microphone explicitly: a live track keeps the browser's
        // recording indicator on and the device busy.
        const microphone = this.microphoneStream;
        this.microphoneStream = null;
        this.microphoneActive = false;
        microphone?.getTracks?.().forEach((track) => track.stop());

        const audioOutput = this.audioOutput;
        this.audioOutput = null;
        try {
            await audioOutput?.close();
        } catch {
            // Releasing audio output should not prevent the session from ending.
        }

        this.state = "idle";
        this.status = status;
        this.sourceTabId = null;
        this.endedAt = this.endedAt || new Date().toISOString();
        this.publishState();
        if (notifyEnded) {
            await this.onEnded(this.exportSnapshot());
        }
    }

    publishState() {
        this.publish({ type: "session-state", snapshot: this.snapshot });
    }
}
