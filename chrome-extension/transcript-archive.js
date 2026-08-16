function parseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value !== "string") {
        return Number.NaN;
    }

    const match = value.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
    if (!match) {
        return Number.NaN;
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Seconds for a wire timestamp, or NaN. Exposed for callers that filter by time. */
export function toSeconds(value) {
    return parseTimestamp(value);
}

function normalizeText(value) {
    return String(value ?? "")
        .replace(/[\u0000-\u001F\u007F]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeLine(line) {
    if (!line || typeof line !== "object") {
        return null;
    }

    const speaker = Number(line.speaker);
    const text = normalizeText(line.text);
    if (!text || speaker === -2 || speaker === 0 || !Number.isFinite(speaker)) {
        return null;
    }

    return {
        start: String(line.start ?? ""),
        end: String(line.end ?? ""),
        speaker,
        text,
    };
}

function lineSort(left, right) {
    const leftStart = parseTimestamp(left.start);
    const rightStart = parseTimestamp(right.start);
    if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) {
        return leftStart - rightStart;
    }
    if (Number.isFinite(leftStart) !== Number.isFinite(rightStart)) {
        return Number.isFinite(leftStart) ? -1 : 1;
    }
    return left.start.localeCompare(right.start) || left.end.localeCompare(right.end) || left.speaker - right.speaker;
}

function cloneLine(line) {
    return { start: line.start, end: line.end, speaker: line.speaker, text: line.text };
}

/**
 * Identity of a line for revision purposes. The server re-sends its whole
 * retention window on every update, so a line is "the same line" when it
 * starts at the same instant, whatever its text has been revised to.
 */
function entryKey(line) {
    const start = parseTimestamp(line.start);
    return Number.isFinite(start) ? start : `raw:${line.start}`;
}

function sameLine(left, right) {
    return left.end === right.end && left.speaker === right.speaker && left.text === right.text;
}

/** Only the tail of an accumulated line can overlap the server's next window. */
const STITCH_LOOKBACK_CHARS = 8000;
const STITCH_MIN_OVERLAP_CHARS = 8;
// normalizeText strips U+0000-U+001F, so this can never occur inside stored text.
const SEPARATOR = "\u0000";

/**
 * The server keeps a line open until it detects a pause longer than five
 * seconds, and prunes that open line's head once it grows past the retention
 * window. The same utterance therefore comes back with a later `start` and its
 * first words missing. Re-join the two halves on their overlapping text.
 *
 * Returns the combined text, or null when the halves do not demonstrably
 * overlap — in which case the caller must keep both lines rather than guess.
 */
function stitchTruncatedText(previousText, incomingText) {
    if (!incomingText) {
        return previousText;
    }
    if (previousText.endsWith(incomingText)) {
        return previousText;
    }

    // The overlap can be as long as the whole incoming line, so the tail we
    // search must always be able to contain it — a fixed window silently stops
    // matching once the retention window outgrows it, and the archive then
    // starts filing a fresh copy of the utterance on every update.
    const lookback = Math.max(STITCH_LOOKBACK_CHARS, incomingText.length + 1024);
    const tail = previousText.length > lookback ? previousText.slice(-lookback) : previousText;

    // Longest prefix of `incomingText` that is also a suffix of `tail`, via the
    // prefix function over "incoming \0 tail". The separator cannot occur in
    // stored text because normalizeText strips control characters, so the
    // result can never run past the end of `incomingText`.
    const joined = incomingText + SEPARATOR + tail;
    const border = new Uint32Array(joined.length);
    for (let i = 1; i < joined.length; i += 1) {
        let length = border[i - 1];
        while (length > 0 && joined[i] !== joined[length]) {
            length = border[length - 1];
        }
        if (joined[i] === joined[length]) {
            length += 1;
        }
        border[i] = length;
    }

    const overlap = border[joined.length - 1];
    if (overlap < STITCH_MIN_OVERLAP_CHARS) {
        return null;
    }
    return previousText + incomingText.slice(overlap);
}

/**
 * Retains only committed speech lines locally, independent of the server's
 * rolling retention window. Buffers are intentionally never archived.
 *
 * The server re-sends up to ~75 lines around 20 times per second and almost
 * all of them are unchanged, so `merge` is built around an O(1) "identical,
 * do nothing" fast path. Revisions and merges of existing lines cost
 * O(log n) instead of scanning and re-sorting the whole archive.
 */
export class TranscriptArchive {
    constructor(lines = []) {
        this.entries = [];
        this.index = new Map();
        this.merge({ lines });
    }

    get lines() {
        return this.entries.map(cloneLine);
    }

    get size() {
        return this.entries.length;
    }

    /** The last `count` lines, without cloning the whole archive to get them. */
    tail(count) {
        const from = Math.max(0, this.entries.length - Math.max(0, count));
        const result = [];
        for (let i = from; i < this.entries.length; i += 1) {
            result.push(cloneLine(this.entries[i]));
        }
        return result;
    }

    clear() {
        this.entries = [];
        this.index = new Map();
    }

    replace(lines) {
        this.clear();
        this.merge({ lines });
    }

    merge(payload) {
        const incomingLines = Array.isArray(payload?.lines) ? payload.lines : [];
        for (const sourceLine of incomingLines) {
            const line = normalizeLine(sourceLine);
            if (line) {
                this.upsert(line);
            }
        }
        return this.lines;
    }

    /** Index of the first entry that does not sort before `probe`. */
    lowerBound(probe) {
        let low = 0;
        let high = this.entries.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (lineSort(this.entries[middle], probe) < 0) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }

    /**
     * Drop entries the server has folded into the incoming line's span. Only
     * the window of entries starting inside [start, end] is examined.
     */
    dropContained(start, end, keepKey) {
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return;
        }

        // Entries are ordered by start time, so binary-search the first one
        // that could begin at or after `start`.
        let low = 0;
        let high = this.entries.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            const middleStart = parseTimestamp(this.entries[middle].start);
            if (Number.isFinite(middleStart) && middleStart < start) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        const from = low;
        let to = from;
        while (to < this.entries.length) {
            const entryStart = parseTimestamp(this.entries[to].start);
            if (!Number.isFinite(entryStart) || entryStart > end) {
                break;
            }
            to += 1;
        }
        if (to === from) {
            return;
        }

        const survivors = [];
        for (let i = from; i < to; i += 1) {
            const entry = this.entries[i];
            const entryEnd = parseTimestamp(entry.end);
            const key = entryKey(entry);
            const contained = Number.isFinite(entryEnd) && entryEnd <= end;
            if (contained && key !== keepKey) {
                this.index.delete(key);
            } else {
                survivors.push(entry);
            }
        }
        if (survivors.length !== to - from) {
            this.entries.splice(from, to - from, ...survivors);
        }
    }

    /** Index of the first entry starting at or after `start`. */
    firstStartingAt(start) {
        let low = 0;
        let high = this.entries.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            const middleStart = parseTimestamp(this.entries[middle].start);
            if (Number.isFinite(middleStart) && middleStart < start) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }

    /**
     * Absorb a line whose head the server has pruned back into the entry it
     * was cut from, so one utterance stays one line instead of accumulating an
     * overlapping copy on every update.
     */
    continueTruncatedLine(start, end, line) {
        if (!Number.isFinite(start)) {
            return false;
        }

        const previousIndex = this.firstStartingAt(start) - 1;
        if (previousIndex < 0) {
            return false;
        }

        const previous = this.entries[previousIndex];
        const previousStart = parseTimestamp(previous.start);
        const previousEnd = parseTimestamp(previous.end);

        // Head truncation lands the new start STRICTLY inside the entry it was
        // cut from. Two merely adjacent lines — one ending exactly where the
        // next begins, which is what consecutive segments look like — must not
        // be mistaken for one utterance and joined.
        const startsInsidePrevious = Number.isFinite(previousStart)
            && Number.isFinite(previousEnd)
            && start > previousStart
            && start < previousEnd;

        if (previous.speaker !== line.speaker || !startsInsidePrevious) {
            return false;
        }
        if (Number.isFinite(end) && end < previousEnd) {
            return false;
        }

        const stitched = stitchTruncatedText(previous.text, line.text);
        if (stitched === null) {
            return false;
        }

        previous.text = stitched;
        if (Number.isFinite(end)) {
            previous.end = line.end;
        }
        return true;
    }

    upsert(line) {
        const key = entryKey(line);
        const existing = this.index.get(key);

        if (existing && sameLine(existing, line)) {
            // The overwhelmingly common case: the server re-sent a line we
            // already hold, unchanged. Nothing to reorder, nothing to drop —
            // an unchanged line cannot have swallowed its neighbours.
            return;
        }

        const start = parseTimestamp(line.start);
        const end = parseTimestamp(line.end);

        if (!existing && this.continueTruncatedLine(start, end, line)) {
            return;
        }

        this.dropContained(start, end, key);

        if (existing) {
            // A revision keeps its start, and therefore its sort position.
            existing.end = line.end;
            existing.speaker = line.speaker;
            existing.text = line.text;
            return;
        }

        this.index.set(key, line);
        const at = this.lowerBound(line);
        if (at === this.entries.length) {
            this.entries.push(line);
        } else {
            this.entries.splice(at, 0, line);
        }
    }
}

/**
 * Escape only what would otherwise change how the text renders. Speech is full
 * of parentheses, dashes and quotes; backslash-escaping all of them turns
 * "IT-отдел (3 человека)" into "IT-отдел \(3 человека\)" and makes the export
 * unpleasant to read and to paste anywhere that is not a Markdown renderer.
 * Angle brackets and ampersands stay escaped because an exported transcript may
 * well be rendered as HTML.
 */
function escapeMarkdownText(value) {
    return normalizeText(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/([\\`*_[\]])/g, "\\$1");
}

/** Markers only have meaning at the start of a line, so only neutralise them there. */
function escapeMarkdownBlock(value) {
    return escapeMarkdownText(value).replace(/^(\s*)([-+#>]|\d+\.)/, "$1\\$2");
}

function toDate(value) {
    if (!value) {
        return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoString(value) {
    const date = toDate(value);
    return date ? date.toISOString() : "—";
}

/** Local wall-clock time, which is what the reader actually thinks in. */
function toLocalString(value) {
    const date = toDate(value);
    if (!date) {
        return "—";
    }
    const pad = (number) => String(number).padStart(2, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? "-" : "+";
    const offset = `UTC${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())} (${offset})`;
}

/** Drop centiseconds: nobody reads a transcript to hundredths of a second. */
function toClock(timestamp) {
    const seconds = parseTimestamp(timestamp);
    if (!Number.isFinite(seconds)) {
        return String(timestamp || "");
    }
    const pad = (number) => String(number).padStart(2, "0");
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    return hours
        ? `${hours}:${pad(minutes)}:${pad(whole % 60)}`
        : `${minutes}:${pad(whole % 60)}`;
}

const PARAGRAPH_TARGET_CHARS = 700;
/** A pause longer than this opens a new, freshly timestamped block. */
const BLOCK_GAP_SECONDS = 20;

/**
 * One archive entry can hold an hour of uninterrupted speech, so split it into
 * paragraphs on sentence boundaries instead of emitting a single wall of text.
 */
function toParagraphs(text) {
    if (!text) {
        return [];
    }

    // Split only at sentence ends: punctuation followed by a space. A period
    // between digits is a date or a number ("15.09."), never a boundary. The
    // paragraph is sliced out of the original string so that no character is
    // added, dropped or moved.
    const boundary = /(?<!\d)[.!?…]+(?=\s)/g;
    const paragraphs = [];
    let from = 0;
    let match;

    while ((match = boundary.exec(text)) !== null) {
        const cut = match.index + match[0].length;
        if (cut - from >= PARAGRAPH_TARGET_CHARS) {
            paragraphs.push(text.slice(from, cut).trim());
            from = cut;
        }
    }

    const remainder = text.slice(from).trim();
    if (remainder) {
        paragraphs.push(remainder);
    }
    return paragraphs.length ? paragraphs : [text];
}

const WINDOWS_RESERVED_NAMES = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Make a browser tab title usable as a Windows filename fragment. */
export function sanitizeFilenamePart(value, maxLength = 60) {
    let cleaned = String(value ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength)
        .replace(/[. ]+$/, "");

    if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
        cleaned = `${cleaned}_`;
    }
    return cleaned;
}

export function makeTranscriptFilename(date = new Date(), title = "") {
    const value = toDate(date) || new Date();
    const pad = (number) => String(number).padStart(2, "0");
    const stamp = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}-${pad(value.getMinutes())}`;
    const name = sanitizeFilenamePart(title);
    return `${stamp} ${name || "стенограмма"}.md`;
}

export const TRANSCRIPT_FORMATS = ["dialogue", "timestamps", "plain"];

function renderTimestamped(lines) {
    return lines.map((line) => {
        const span = line.start && line.end
            ? `${toClock(line.start)}–${toClock(line.end)}`
            : toClock(line.start || line.end) || "без метки времени";
        return `- **[${span} · Спикер ${line.speaker}]:** ${escapeMarkdownText(line.text)}`;
    });
}

/**
 * Consecutive lines from one speaker become one block, headed by the moment it
 * started. With diarization off every line carries speaker 1, so the label is
 * dropped entirely rather than repeated as a meaningless "Спикер 1" on
 * every paragraph.
 */
function renderDialogue(lines, { markdown = true, groupTurns = true } = {}) {
    const speakers = new Set(lines.map((line) => line.speaker));
    const labelSpeakers = speakers.size > 1;
    const escape = markdown ? escapeMarkdownBlock : (value) => normalizeText(value);

    // A block is an uninterrupted turn: same speaker, no long gap. Its lines are
    // joined back into prose and only then split into paragraphs, so the export
    // reads as speech rather than as a list of recogniser outputs.
    const blocks = [];
    for (const line of lines) {
        const open = blocks[blocks.length - 1];
        const gap = open ? parseTimestamp(line.start) - parseTimestamp(open.end) : Number.NaN;
        const continues = groupTurns
            && open
            && open.speaker === line.speaker
            && (!Number.isFinite(gap) || gap <= BLOCK_GAP_SECONDS);

        if (continues) {
            open.text = `${open.text} ${line.text}`;
            open.end = line.end;
        } else {
            blocks.push({ speaker: line.speaker, start: line.start, end: line.end, text: line.text });
        }
    }

    const output = [];
    for (const block of blocks) {
        if (output.length) {
            output.push("");
        }
        const label = [labelSpeakers ? `Спикер ${block.speaker}` : "", toClock(block.start)]
            .filter(Boolean)
            .join(" · ");
        output.push(markdown ? `**${label}**` : `[${label}]`, "");

        const paragraphs = toParagraphs(block.text);
        for (let i = 0; i < paragraphs.length; i += 1) {
            output.push(escape(paragraphs[i]));
            if (i < paragraphs.length - 1) {
                output.push("");
            }
        }
    }
    return output;
}

/** Local HH:MM, for naming a segment by when it was recorded. */
function toLocalClock(value) {
    const date = toDate(value);
    if (!date) {
        return "";
    }
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Split the lines into the recorded stretches they belong to.
 *
 * A stretch opens every time the user presses "Продолжить", by which point
 * they are usually watching something else — so each one is headed by the tab
 * title captured at that moment. A line belongs to the last stretch that had
 * opened by the time it started.
 */
function groupBySegment(lines, segments) {
    const usable = (segments || [])
        .map((segment) => ({ ...segment, at: parseTimestamp(segment.fromServerTime) }))
        .map((segment) => ({ ...segment, at: Number.isFinite(segment.at) ? segment.at : 0 }));

    if (usable.length < 2) {
        return [{ segment: null, lines }];
    }

    const groups = usable.map((segment) => ({ segment, lines: [] }));
    for (const line of lines) {
        const start = parseTimestamp(line.start);
        let index = 0;
        for (let i = 0; i < usable.length; i += 1) {
            if (Number.isFinite(start) && start >= usable[i].at) {
                index = i;
            }
        }
        groups[index].lines.push(line);
    }
    return groups.filter((group) => group.lines.length);
}

export function formatTranscriptMarkdown({
    startedAt = null,
    endedAt = null,
    exportedAt = new Date(),
    finalized = false,
    lines = [],
    segments = [],
    bufferTranscription = "",
    title = "",
    format = "dialogue",
    preMerged = false,
} = {}) {
    // Lines taken straight from an archive are already normalised and deduped;
    // re-merging them on every flush of the live file would be pure waste.
    const entries = preMerged ? lines : new TranscriptArchive(lines).lines;
    const chosen = TRANSCRIPT_FORMATS.includes(format) ? format : "dialogue";
    const plain = chosen === "plain";
    const state = finalized
        ? "Финализировано сервером"
        : "Промежуточный экспорт — сервер ещё не подтвердил финализацию";

    const heading = title ? `Стенограмма: ${escapeMarkdownText(title)}` : "Стенограмма видеоконференции";
    const documentLines = plain ? [heading, ""] : [
        `# ${heading}`,
        "",
        "> Автоматическая транскрипция. Перед распространением проверьте текст и атрибуцию спикеров.",
        "",
    ];

    documentLines.push(
        `- Начато: ${toLocalString(startedAt)}`,
        `- Завершено: ${toLocalString(endedAt)}`,
        `- Экспортировано: ${toLocalString(exportedAt)}`,
        `- Начато (UTC): ${toIsoString(startedAt)}`,
        `- Статус: ${state}`,
        "- Источник: аудио вкладки браузера",
        `- Реплик: ${entries.length}`,
        "",
        plain ? "Текст" : "## Текст",
        "",
    );

    if (entries.length === 0) {
        documentLines.push(plain ? "Финализированных реплик пока нет." : "_Финализированных реплик пока нет._");
    } else {
        const groups = groupBySegment(entries, segments);
        let first = true;
        for (const group of groups) {
            if (group.segment) {
                if (!first) {
                    documentLines.push("");
                }
                const clock = toLocalClock(group.segment.startedAt);
                const name = group.segment.title ? escapeMarkdownText(group.segment.title) : "фрагмент";
                const heading = [clock, name].filter(Boolean).join(" — ");
                documentLines.push(plain ? heading : `### ${heading}`, "");
            }
            first = false;

            documentLines.push(...(chosen === "timestamps"
                ? renderTimestamped(group.lines)
                : renderDialogue(group.lines, { markdown: !plain })));
        }
    }

    const unfinished = normalizeText(bufferTranscription);
    if (!finalized && unfinished) {
        documentLines.push(
            "",
            plain ? "Нефинализированный фрагмент" : "## Нефинализированный фрагмент",
            "",
        );
        if (!plain) {
            documentLines.push("> Этот фрагмент может измениться после обработки сервером.", "");
        }
        documentLines.push(plain ? unfinished : escapeMarkdownBlock(unfinished));
    }

    return `${documentLines.join("\n")}\n`;
}

/** A single phrase, for the per-line copy buttons in the side panel. */
export function formatLineForCopy(line, { withTimestamp = false } = {}) {
    const text = normalizeText(line?.text);
    if (!withTimestamp) {
        return text;
    }
    const clock = toClock(line?.start);
    return clock ? `[${clock}] ${text}` : text;
}

/** Several selected phrases, as a Markdown quote block with timestamps. */
export function formatLinesForCopy(lines, { withTimestamps = true, markdown = true } = {}) {
    const usable = (lines || []).filter((line) => normalizeText(line?.text));
    if (!usable.length) {
        return "";
    }
    if (!markdown) {
        return usable.map((line) => formatLineForCopy(line, { withTimestamp: withTimestamps })).join("\n");
    }
    // The reader picked these phrases individually, so each stays its own
    // block — merging neighbours back into one paragraph would undo the choice.
    return renderDialogue(usable, { markdown: true, groupTurns: false }).join("\n");
}
