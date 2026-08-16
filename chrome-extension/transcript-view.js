/**
 * Incremental rendering of the live transcript.
 *
 * The server pushes an update roughly twenty times a second, so the previous
 * approach — rebuilding every line on every message — destroyed any text the
 * reader was selecting with the mouse within 50 ms and made copying a phrase
 * impossible. This view touches only what actually changed and leaves the rest
 * of the DOM, and therefore the selection, alone.
 */

const DEFAULT_MAX_LINES = 300;
/** Rebuild in chunks rather than per line, so trimming stays rare. */
const TRIM_SLACK = 100;
/** How close to the bottom still counts as "following the conversation". */
const PIN_TOLERANCE_PX = 40;

export function isPinnedToBottom(element, tolerance = PIN_TOLERANCE_PX) {
    const distance = (element.scrollHeight || 0) - (element.scrollTop || 0) - (element.clientHeight || 0);
    return distance <= tolerance;
}

function clockOf(timestamp) {
    const match = String(timestamp || "").match(/^(\d+):(\d{2}):(\d{2})/);
    if (!match) {
        return "";
    }
    const hours = Number(match[1]);
    return hours ? `${hours}:${match[2]}:${match[3]}` : `${Number(match[2])}:${match[3]}`;
}

export class TranscriptView {
    constructor({
        container,
        documentObject = document,
        onCopyLine = () => {},
        onToggleLine = () => {},
        maxLines = DEFAULT_MAX_LINES,
        labelSpeakers = false,
    }) {
        this.container = container;
        this.documentObject = documentObject;
        this.onCopyLine = onCopyLine;
        this.onToggleLine = onToggleLine;
        this.maxLines = maxLines;
        this.labelSpeakers = labelSpeakers;

        /** key -> { element, textElement, metaElement, line } */
        this.rendered = new Map();
        this.renderedKeys = [];
        this.selected = new Set();
        this.bufferElement = null;
        this.bufferTextElement = null;
        this.bufferText = "";
    }

    keyOf(line) {
        return String(line.start);
    }

    createLineElement(key, line) {
        const element = this.documentObject.createElement("article");
        element.className = "line";

        const meta = this.documentObject.createElement("header");
        meta.className = "line-meta";

        const clock = this.documentObject.createElement("span");
        clock.className = "line-clock";
        clock.textContent = clockOf(line.start);
        meta.append(clock);

        if (this.labelSpeakers) {
            const speaker = this.documentObject.createElement("span");
            speaker.className = "line-speaker";
            speaker.textContent = `Спикер ${line.speaker}`;
            meta.append(speaker);
        }

        const copyButton = this.documentObject.createElement("button");
        copyButton.type = "button";
        copyButton.className = "line-copy";
        copyButton.title = "Копировать реплику";
        copyButton.textContent = "Копировать";
        copyButton.addEventListener("click", (event) => {
            event?.stopPropagation?.();
            this.onCopyLine(key);
        });
        meta.append(copyButton);

        const text = this.documentObject.createElement("div");
        text.className = "line-text";
        text.textContent = line.text;

        element.append(meta);
        element.append(text);
        element.addEventListener("dblclick", () => this.onCopyLine(key));
        element.addEventListener("click", (event) => {
            // Plain clicks must stay free for selecting text with the mouse.
            if (event?.ctrlKey || event?.metaKey) {
                event.preventDefault?.();
                this.onToggleLine(key);
            }
        });

        return { element, textElement: text, metaElement: meta, line: { ...line } };
    }

    applySelection(key, entry) {
        const selected = this.selected.has(key);
        const next = selected ? "line selected" : "line";
        if (entry.element.className !== next) {
            entry.element.className = next;
        }
    }

    setSelected(keys) {
        this.selected = new Set(keys);
        for (const [key, entry] of this.rendered) {
            this.applySelection(key, entry);
        }
    }

    rebuild(lines) {
        this.container.replaceChildren();
        this.rendered = new Map();
        this.renderedKeys = [];
        for (const line of lines) {
            const key = this.keyOf(line);
            const entry = this.createLineElement(key, line);
            this.applySelection(key, entry);
            this.rendered.set(key, entry);
            this.renderedKeys.push(key);
            this.container.append(entry.element);
        }
        this.bufferElement = null;
        this.renderBuffer(this.bufferText);
    }

    /**
     * Drop rows that have slid out of the caller's window. The caller feeds a
     * fixed-size tail, so once a meeting passes that size the window advances
     * by one on every committed line; without this the whole list would be
     * rebuilt each time, which is exactly what this view exists to avoid.
     */
    dropLeadingUntil(firstKey) {
        const at = this.renderedKeys.indexOf(firstKey);
        if (at <= 0) {
            return at === 0;
        }
        for (const key of this.renderedKeys.slice(0, at)) {
            this.rendered.get(key)?.element.remove();
            this.rendered.delete(key);
        }
        this.renderedKeys = this.renderedKeys.slice(at);
        return true;
    }

    /** True when `lines` merely extends what is already on screen. */
    isPureAppend(lines) {
        if (lines.length < this.renderedKeys.length) {
            return false;
        }
        for (let i = 0; i < this.renderedKeys.length; i += 1) {
            if (this.keyOf(lines[i]) !== this.renderedKeys[i]) {
                return false;
            }
        }
        return true;
    }

    renderBuffer(text) {
        this.bufferText = text || "";

        if (!this.bufferText) {
            if (this.bufferElement) {
                this.bufferElement.remove();
                this.bufferElement = null;
            }
            return;
        }

        if (!this.bufferElement) {
            const element = this.documentObject.createElement("article");
            element.className = "line buffer";
            const text_ = this.documentObject.createElement("div");
            text_.className = "line-text";
            element.append(text_);
            this.bufferElement = element;
            this.bufferTextElement = text_;
            this.container.append(element);
        }
        if (this.bufferTextElement.textContent !== this.bufferText) {
            this.bufferTextElement.textContent = this.bufferText;
        }
    }

    /**
     * Bring the DOM in line with `lines`, touching as little as possible.
     * Returns the number of DOM nodes created, which the tests use to prove the
     * view is not rebuilding itself on every update.
     */
    sync(lines, bufferText = "") {
        const visible = lines.length > this.maxLines + TRIM_SLACK
            ? lines.slice(-this.maxLines)
            : lines;

        // A window that merely slid forward is still an append once the rows
        // that fell off the front are removed.
        if (visible.length && this.renderedKeys.length && !this.isPureAppend(visible)) {
            this.dropLeadingUntil(this.keyOf(visible[0]));
        }

        if (!this.isPureAppend(visible)) {
            this.rebuild(visible);
            this.renderBuffer(bufferText);
            return this.rendered.size;
        }

        let created = 0;
        for (let i = 0; i < visible.length; i += 1) {
            const line = visible[i];
            const key = this.keyOf(line);
            const entry = this.rendered.get(key);

            if (!entry) {
                const fresh = this.createLineElement(key, line);
                this.applySelection(key, fresh);
                this.rendered.set(key, fresh);
                this.renderedKeys.push(key);
                // Appending after the buffer would put it out of order, so the
                // buffer is detached and re-appended below.
                if (this.bufferElement) {
                    this.bufferElement.remove();
                    this.bufferElement = null;
                }
                this.container.append(fresh.element);
                created += 1;
                continue;
            }

            if (entry.line.text !== line.text) {
                entry.textElement.textContent = line.text;
                entry.line.text = line.text;
            }
            entry.line.end = line.end;
        }

        this.renderBuffer(bufferText);
        return created;
    }

    lineAt(key) {
        return this.rendered.get(key)?.line || null;
    }

    clear() {
        this.container.replaceChildren();
        this.rendered = new Map();
        this.renderedKeys = [];
        this.selected = new Set();
        this.bufferElement = null;
        this.bufferTextElement = null;
        this.bufferText = "";
    }
}
