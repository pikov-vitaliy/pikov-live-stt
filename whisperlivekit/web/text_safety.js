(function installTextSafety(globalScope) {
  "use strict";

  const HTML_ENTITIES = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  });

  /** Encode untrusted ASR/WebSocket values before inserting them into HTML. */
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
  }

  globalScope.WhisperLiveKitTextSafety = Object.freeze({ escapeHtml });
})(globalThis);
