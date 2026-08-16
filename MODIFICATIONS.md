# Pikov LiveSTT modification and provenance record

This repository is a modified derivative of
[QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit),
distributed under the Apache License, Version 2.0.

## Provenance

- Original project: `QuentinFuxa/WhisperLiveKit`.
- Original PoC starting point: tag `v0.2.25`, commit
  `db78a58f3dc02528cf989f7be827d0ff248873dc`.
- Upstream base used for the public fork: commit
  `7772ad0e5264252ce0d62c525d008e6b6982f98a`.
- Derivative maintainer: Vitaly Pikov (`pikov-vitaliy`).
- Initial derivative commits after rebasing onto the public base:
  `ae162d9`, `b2a92ac`, `616332e`, and `bc383d5`.

The GitHub fork relationship and Git history provide the detailed line-level
provenance. This document is the prominent change notice for redistribution and
does not replace notices carried by individual modified source files.

## Material changes

Pikov LiveSTT adds a Windows-focused local conference transcription profile:

- a persistent Manifest V3 tab-capture architecture using a service worker and
  offscreen document;
- optional microphone mixing, pause/resume, finalization, and safe resource
  release;
- full-session transcript archival, recovery, display controls, and explicit
  Markdown/plain-text/timestamped export;
- optional live writing to a user-selected Markdown file;
- a loopback-only Docker Desktop GPU profile for Russian `large-v3`
  transcription through `faster-whisper` and LocalAgreement;
- an inference-based PowerShell readiness check and Russian operating
  documentation.

Publication hardening adds derivative attribution and third-party notices, a
scoped SPDX 2.3 source SBOM, least-privilege GitHub workflow permissions,
full-SHA action pins, exact CI tool versions, JavaScript-aware CodeQL, and the
69-test Chromium extension suite as a CI job. A post-publication CodeQL finding
is addressed by context-safe HTML encoding for every WebSocket-derived value in
the bundled Web UI, with inline-resource and generated-extension synchronization
regression tests. The publication-candidate
dependency audit and bounded VEX decisions are recorded under `docs/`.
Git attributes preserve the exact SBOM bytes covered by its SHA-256 checksum.
Docker publication
workflows are retained for future use but no image or release is published by
this source-only preparation.

The upstream Python import name (`whisperlivekit`), CLI (`wlk`), WebSocket/API
contracts, Docker service identifiers, and internal storage schema identifiers
remain unchanged for compatibility.

## Upstream files modified by the derivative

The following files originate in upstream WhisperLiveKit and carry derivative
changes in this repository:

- `.gitignore`;
- `.github/CODEOWNERS`;
- `.github/ISSUE_TEMPLATE/bug_report.yml`;
- `.github/ISSUE_TEMPLATE/config.yml`;
- `.github/ISSUE_TEMPLATE/feature_request.yml`;
- `.github/workflows/docker-image.yml`;
- `.github/workflows/ci.yml`;
- `.github/workflows/codeql.yml`;
- `.github/workflows/publish-docker.yml`;
- `CONTRIBUTING.md`;
- `CODE_OF_CONDUCT.md` (Pikov LiveSTT confidential reporting channel);
- `LICENSE` (attribution URL correction only; license terms are unchanged);
- `README.md`;
- `SECURITY.md`;
- `pyproject.toml`;
- `scripts/sync_extension.py`;
- `chrome-extension/README.md`;
- `chrome-extension/background.js`;
- `chrome-extension/manifest.json`;
- `chrome-extension/requestPermissions.html`;
- `chrome-extension/requestPermissions.js`;
- `chrome-extension/sidepanel.js`;
- `whisperlivekit/web/live_transcription.html`;
- `whisperlivekit/web/live_transcription.js`;
- `whisperlivekit/web/web_interface.py`.

Each source or configuration format that supports comments also carries a short
modified-file notice. The manifest uses its standard `description` field because
JSON does not support comments.

## Files added by the derivative

The derivative adds the conference Docker profile and readiness check, Russian
runbooks under `docs/`, the persistent extension runtime, presentation,
archive, export, file-writer, and test modules under `chrome-extension/`, and
the Web UI text-safety helper `whisperlivekit/web/text_safety.js`, and
the derivative/third-party attribution files `NOTICE`,
`THIRD_PARTY_NOTICES.md`, and `THIRD_PARTY_LICENSES.md`, plus a scoped source
SBOM under `sbom/`, its checksum-preserving `.gitattributes` rule, and the
security audit under `docs/`.

## Components not redistributed here

Whisper `large-v3` weights are downloaded into a local Docker volume and are not
tracked by this repository. Users must review and accept the applicable terms
for any model or optional backend they choose to download.

Bundled-source provenance and retained license texts are documented in
`THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md`. These files do not claim
license clearance for the complete transitive contents of a future Docker
image; that image requires its own SBOM and license review.

The repository retains upstream's pinned `third_party/qwen3-asr-causal`
submodule reference. Its code and any optional model weights remain governed by
their own upstream license and provenance.
