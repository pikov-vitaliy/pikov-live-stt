import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = dirname(testDirectory);
const archivePath = join(extensionDirectory, "transcript-archive.js");

async function loadTranscriptArchive() {
  assert.ok(existsSync(archivePath), "the extension needs a transcript archive independent of the five-minute server window");
  return import(`${pathToFileURL(archivePath).href}?test=${Date.now()}`);
}

test("archive retains finalized lines after the server rolling window advances", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  archive.merge({
    lines: [
      { start: "00:00:01.00", end: "00:00:03.00", speaker: 1, text: "Ранняя реплика" },
      { start: "00:00:04.00", end: "00:00:05.00", speaker: 0, text: "Черновая атрибуция" },
      { start: "00:00:06.00", end: "00:00:07.00", speaker: -2, text: "" },
    ],
  });
  archive.merge({
    lines: [
      { start: "00:05:01.00", end: "00:05:03.00", speaker: 2, text: "Старая версия хвоста" },
    ],
  });
  archive.merge({
    lines: [
      { start: "00:05:01.00", end: "00:05:03.00", speaker: 2, text: "Исправленная версия хвоста" },
    ],
  });

  assert.deepEqual(archive.lines, [
    { start: "00:00:01.00", end: "00:00:03.00", speaker: 1, text: "Ранняя реплика" },
    { start: "00:05:01.00", end: "00:05:03.00", speaker: 2, text: "Исправленная версия хвоста" },
  ]);
});

function line(startSeconds, endSeconds, text, speaker = 1) {
  const format = (seconds) => {
    const centiseconds = Math.round(seconds * 100) % 100;
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
  };
  return { start: format(startSeconds), end: format(endSeconds), speaker, text };
}

test("re-sending an unchanged server window does not disturb the archive", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();
  const window = { lines: [line(0, 4, "Первая"), line(4, 8, "Вторая"), line(8, 12, "Третья")] };

  archive.merge(window);
  const afterFirstMerge = archive.lines;
  for (let i = 0; i < 50; i += 1) {
    archive.merge(window);
  }

  assert.equal(archive.size, 3, "repeated identical windows must not duplicate lines");
  assert.deepEqual(archive.lines, afterFirstMerge, "repeated identical windows must not reorder or rewrite lines");
});

test("a line the server later folds into a longer one replaces it", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  archive.merge({ lines: [line(0, 4, "Мы обсудили"), line(4, 8, "план работ")] });
  // localagreement re-emits both fragments as a single committed line.
  archive.merge({ lines: [line(0, 8, "Мы обсудили план работ")] });

  assert.deepEqual(archive.lines, [line(0, 8, "Мы обсудили план работ")]);
});

test("folding a span leaves lines outside that span untouched", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  archive.merge({ lines: [line(0, 4, "Раньше"), line(10, 14, "Внутри"), line(30, 34, "Позже")] });
  archive.merge({ lines: [line(8, 20, "Объединённый фрагмент")] });

  assert.deepEqual(archive.lines, [
    line(0, 4, "Раньше"),
    line(8, 20, "Объединённый фрагмент"),
    line(30, 34, "Позже"),
  ]);
});

test("a late-arriving earlier line is placed in chronological order", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  archive.merge({ lines: [line(20, 24, "Позже")] });
  archive.merge({ lines: [line(4, 8, "Раньше")] });

  assert.deepEqual(archive.lines.map((entry) => entry.text), ["Раньше", "Позже"]);
});

test("lines without usable timestamps do not accumulate on every resend", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();
  const payload = { lines: [{ start: "", end: "", speaker: 1, text: "Без метки времени" }] };

  archive.merge(payload);
  archive.merge(payload);
  archive.merge(payload);

  assert.equal(archive.size, 1, "an unparseable timestamp must still deduplicate against itself");
});

test("a line whose head the server pruned stays one line instead of duplicating", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  // The server keeps a line open until a pause longer than five seconds, and
  // prunes its head once it outgrows --retention-seconds. Same utterance, later
  // start, first words gone.
  archive.merge({ lines: [line(0, 300, "первое второе третье")] });
  archive.merge({ lines: [line(10, 310, "второе третье четвёртое")] });
  archive.merge({ lines: [line(20, 320, "третье четвёртое пятое")] });

  assert.equal(archive.size, 1, "head pruning must not file a second copy of the same speech");
  assert.deepEqual(archive.lines, [line(0, 320, "первое второе третье четвёртое пятое")]);
});

test("head pruning across a long meeting keeps the archive flat and the text whole", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();
  const spoken = Array.from({ length: 400 }, (_, index) => `слово${index}`);
  const WINDOW = 75;

  for (let spokenCount = 1; spokenCount <= spoken.length; spokenCount += 1) {
    const from = Math.max(0, spokenCount - WINDOW);
    archive.merge({
      lines: [line(from * 4, spokenCount * 4, spoken.slice(from, spokenCount).join(" "))],
    });
  }

  assert.equal(archive.size, 1, "one continuous utterance must stay one archive entry");
  assert.equal(archive.lines[0].text, spoken.join(" "), "no spoken word may be lost or repeated");
});

test("stitching still works when the server window is larger than the search window", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();
  // Each retained window here is well over 8 000 characters, which is what a
  // two-hour meeting actually looks like once --retention-seconds 300 is in play.
  const spoken = Array.from({ length: 4000 }, (_, index) => `предложение-номер-${index}`);
  const WINDOW = 900;

  for (let spokenCount = 1; spokenCount <= spoken.length; spokenCount += 1) {
    const from = Math.max(0, spokenCount - WINDOW);
    archive.merge({
      lines: [line(from * 4, spokenCount * 4, spoken.slice(from, spokenCount).join(" "))],
    });
  }

  assert.equal(archive.size, 1, "a long meeting must not start filing a fresh copy per update");
  assert.equal(archive.lines[0].text, spoken.join(" "));
});

test("consecutive lines that merely touch are never joined", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  // Segments are contiguous: one ends exactly where the next begins. Even when
  // the recogniser produces identical wording, these are two separate lines,
  // not one utterance whose head was pruned.
  archive.merge({
    lines: [
      line(0, 4, "Обсудили распределение задач между командами."),
      line(4, 8, "Обсудили распределение задач между командами."),
      line(8, 12, "Обсудили распределение задач между командами."),
    ],
  });

  assert.equal(archive.size, 3, "touching lines must stay separate entries");
});

test("overlapping lines that share no text are both kept rather than guessed at", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();

  archive.merge({ lines: [line(0, 300, "совершенно один текст")] });
  archive.merge({ lines: [line(10, 310, "полностью другой текст без общего начала")] });

  assert.equal(archive.size, 2, "without demonstrable overlap the archive must not invent a join");
});

test("tail returns the most recent lines without cloning the whole archive", async () => {
  const { TranscriptArchive } = await loadTranscriptArchive();
  const archive = new TranscriptArchive();
  archive.merge({ lines: Array.from({ length: 10 }, (_, index) => line(index * 4, index * 4 + 4, `Реплика ${index}`)) });

  assert.deepEqual(archive.tail(3).map((entry) => entry.text), ["Реплика 7", "Реплика 8", "Реплика 9"]);
  assert.equal(archive.tail(50).length, 10, "asking for more lines than exist returns everything");
  assert.equal(archive.tail(0).length, 0);
});

test("Markdown export contains the complete archive and marks an unfinished tail", async () => {
  const { formatTranscriptMarkdown, makeTranscriptFilename } = await loadTranscriptArchive();
  const lines = Array.from({ length: 301 }, (_, index) => {
    const totalSeconds = 300 + index;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return {
      start: `00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.00`,
      end: `00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.50`,
      speaker: 1,
      text: index === 0 ? "# <script>alert(1)</script> **не разметка**" : `Реплика ${index}`,
    };
  });

  const markdown = formatTranscriptMarkdown({
    startedAt: "2026-08-16T10:00:00.000Z",
    endedAt: null,
    exportedAt: new Date("2026-08-16T10:05:00.000Z"),
    finalized: false,
    lines,
    bufferTranscription: "Незавершённая реплика",
  });

  assert.match(markdown, /# Стенограмма видеоконференции/);
  assert.match(markdown, /Промежуточный экспорт/);
  assert.match(markdown, /Реплика 300/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /## Нефинализированный фрагмент/);
  assert.match(markdown, /Незавершённая реплика/);
});

test("ordinary speech punctuation survives the export unescaped", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const markdown = formatTranscriptMarkdown({
    lines: [line(0, 4, "IT-отдел (3 человека) отвечает за 1С — согласуем до 15.09.")],
  });

  assert.match(markdown, /IT-отдел \(3 человека\) отвечает за 1С — согласуем до 15\.09\./);
  assert.doesNotMatch(markdown, /\\\(/, "parentheses must not be backslash-escaped");
  assert.doesNotMatch(markdown, /\\-/, "dashes must not be backslash-escaped");
});

test("a single-speaker transcript is not labelled Спикер 1 on every paragraph", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const markdown = formatTranscriptMarkdown({
    lines: [line(0, 4, "Первая мысль."), line(4, 8, "Вторая мысль.")],
  });

  assert.doesNotMatch(markdown, /Спикер 1/, "one speaker means the label carries no information");
});

test("two speakers are labelled and each change opens a new block", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const markdown = formatTranscriptMarkdown({
    lines: [line(0, 4, "Вопрос.", 1), line(4, 8, "Ответ.", 2), line(8, 12, "Уточнение.", 1)],
  });

  assert.match(markdown, /\*\*Спикер 1 · 0:00\*\*/);
  assert.match(markdown, /\*\*Спикер 2 · 0:04\*\*/);
  assert.equal(markdown.match(/\*\*Спикер 1/g).length, 2, "returning to a speaker opens a new block");
});

test("an hour of uninterrupted speech is broken into readable paragraphs", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const sentence = "Обсудили распределение задач между командами на следующий квартал. ";
  const markdown = formatTranscriptMarkdown({ lines: [line(0, 3600, sentence.repeat(80).trim())] });

  const body = markdown.split("## Текст")[1];
  const paragraphs = body.split("\n\n").filter((block) => block.trim());
  assert.ok(paragraphs.length > 5, `one archive entry must not become one wall of text (got ${paragraphs.length})`);
  assert.ok(
    paragraphs.every((block) => block.length < 1200),
    "no paragraph should be unreadably long",
  );
});

test("recorded stretches become named headings in the export", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const at = (hour, minute) => new Date(2026, 7, 16, hour, minute).toISOString();

  const markdown = formatTranscriptMarkdown({
    finalized: true,
    segments: [
      { index: 1, startedAt: at(20, 10), title: "Разбор инцидента", fromServerTime: "" },
      { index: 2, startedAt: at(20, 41), title: "Настройка SIEM", fromServerTime: "0:04:00.00" },
    ],
    lines: [line(0, 120, "Первый ролик."), line(240, 360, "Второй ролик.")],
  });

  assert.match(markdown, /### 20:10 — Разбор инцидента/);
  assert.match(markdown, /### 20:41 — Настройка SIEM/);
  assert.ok(
    markdown.indexOf("Первый ролик.") < markdown.indexOf("### 20:41"),
    "each line must sit under the stretch it was recorded in",
  );
});

test("a single stretch adds no heading at all", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const markdown = formatTranscriptMarkdown({
    segments: [{ index: 1, startedAt: new Date().toISOString(), title: "Встреча", fromServerTime: "" }],
    lines: [line(0, 4, "Единственный фрагмент.")],
  });

  assert.doesNotMatch(markdown, /^### /m, "one uninterrupted recording needs no sub-headings");
});

test("the plain-text format carries no Markdown decoration", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const markdown = formatTranscriptMarkdown({
    lines: [line(0, 4, "Текст со * звёздочкой и _подчёркиванием_.")],
    format: "plain",
  });

  assert.doesNotMatch(markdown, /^#/m);
  assert.doesNotMatch(markdown, /\\/, "plain text must not contain escape backslashes");
  assert.match(markdown, /Текст со \* звёздочкой и _подчёркиванием_\./);
});

test("the timestamped format is still available for those who want it", async () => {
  const { formatTranscriptMarkdown } = await loadTranscriptArchive();
  const markdown = formatTranscriptMarkdown({
    lines: [line(65, 70, "Реплика с меткой.")],
    format: "timestamps",
  });

  assert.match(markdown, /- \*\*\[1:05–1:10 · Спикер 1\]:\*\* Реплика с меткой\./);
});

test("the filename uses local time and the meeting name", async () => {
  const { makeTranscriptFilename, sanitizeFilenamePart } = await loadTranscriptArchive();

  // Built from local components, so the expectation holds in any timezone.
  const at = new Date(2026, 7, 16, 14, 5, 0);
  assert.equal(makeTranscriptFilename(at, "Контур.Толк — планёрка"), "2026-08-16 14-05 Контур.Толк — планёрка.md");
  assert.equal(makeTranscriptFilename(at, ""), "2026-08-16 14-05 стенограмма.md");

  assert.equal(sanitizeFilenamePart('отчёт: "итоги"/2026?'), "отчёт итоги 2026");
  assert.equal(sanitizeFilenamePart("CON"), "CON_", "Windows reserved device names must not be produced");
  assert.equal(sanitizeFilenamePart("имя."), "имя", "Windows rejects trailing dots");
  assert.ok(sanitizeFilenamePart("я".repeat(200)).length <= 60);
});

test("single phrases and selections copy cleanly", async () => {
  const { formatLineForCopy, formatLinesForCopy } = await loadTranscriptArchive();
  const first = line(65, 70, "Первая реплика.");
  const second = line(70, 75, "Вторая реплика.");

  assert.equal(formatLineForCopy(first), "Первая реплика.");
  assert.equal(formatLineForCopy(first, { withTimestamp: true }), "[1:05] Первая реплика.");
  assert.equal(
    formatLinesForCopy([first, second], { markdown: false }),
    "[1:05] Первая реплика.\n[1:10] Вторая реплика.",
  );
  // Individually picked phrases stay individually labelled, even when they sit
  // next to each other: the reader chose them as separate items.
  const selection = formatLinesForCopy([first, second]);
  assert.match(selection, /\*\*1:05\*\*/);
  assert.match(selection, /\*\*1:10\*\*/);
  assert.doesNotMatch(selection, /Первая реплика\. Вторая реплика\./);
  assert.equal(formatLinesForCopy([]), "");
});
