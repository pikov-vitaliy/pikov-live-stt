import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const helperUrl = new URL("../../whisperlivekit/web/text_safety.js", import.meta.url);

async function loadTextSafety() {
  const source = await readFile(helperUrl, "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: helperUrl.pathname });
  return context.WhisperLiveKitTextSafety;
}

test("HTML escaping neutralizes mixed-case tags and attribute payloads", async () => {
  const { escapeHtml } = await loadTextSafety();

  assert.equal(
    escapeHtml(`<SCRIPT src=x onerror="alert('xss')">&</SCRIPT>`),
    "&lt;SCRIPT src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;&lt;/SCRIPT&gt;",
  );
});

test("HTML escaping preserves ordinary transcript text", async () => {
  const { escapeHtml } = await loadTextSafety();

  assert.equal(escapeHtml("ГОСТ Р 56939-2024 — SBOM/CWE"), "ГОСТ Р 56939-2024 — SBOM/CWE");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "");
});
