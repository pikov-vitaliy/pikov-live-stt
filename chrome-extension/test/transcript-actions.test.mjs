import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = dirname(testDirectory);
const actionsPath = join(extensionDirectory, "transcript-actions.js");

async function loadActions() {
  assert.ok(existsSync(actionsPath), "copying and downloading transcripts must use a dedicated local action module");
  return import(`${pathToFileURL(actionsPath).href}?test=${Date.now()}`);
}

test("copy action writes the exact Markdown only after an explicit button action", async () => {
  const { copyMarkdownToClipboard } = await loadActions();
  const copied = [];

  await copyMarkdownToClipboard("# Стенограмма\n", {
    writeText: async (value) => copied.push(value),
  });

  assert.deepEqual(copied, ["# Стенограмма\n"]);
});

test("download action creates a Markdown file without requesting the broad downloads permission", async () => {
  const { downloadMarkdown } = await loadActions();
  const calls = [];
  const anchor = {
    click() { calls.push("click"); },
    remove() { calls.push("remove"); },
  };
  const documentObject = {
    body: { append: (node) => { assert.equal(node, anchor); calls.push("append"); } },
    createElement: (tagName) => {
      assert.equal(tagName, "a");
      return anchor;
    },
  };
  const urlObject = {
    createObjectURL: (blob) => {
      calls.push({ type: "blob", size: blob.size, contentType: blob.type });
      return "blob:test";
    },
    revokeObjectURL: (url) => calls.push({ type: "revoke", url }),
  };
  let scheduled;

  const filename = downloadMarkdown("# Стенограмма\n", "meeting-transcript.md", {
    documentObject,
    urlObject,
    BlobType: Blob,
    schedule: (callback) => { scheduled = callback; },
  });

  assert.equal(filename, "meeting-transcript.md");
  assert.equal(anchor.href, "blob:test");
  assert.equal(anchor.download, "meeting-transcript.md");
  assert.deepEqual(calls.slice(0, 3), [{ type: "blob", size: 25, contentType: "text/markdown;charset=utf-8" }, "append", "click"]);
  scheduled();
  assert.ok(calls.some((call) => call.type === "revoke" && call.url === "blob:test"));
  assert.ok(calls.includes("remove"));
});
