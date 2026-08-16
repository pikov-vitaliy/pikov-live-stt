# Source SBOM

`pikov-live-stt-source.spdx.json` is an SPDX 2.3 inventory of packages detected
in this source checkout. It was generated with Anchore Syft 1.43.0 from the
publication candidate dated 2026-08-16:

```powershell
syft scan dir:. `
  --source-name pikov-live-stt `
  --source-version 0.2.25-pikov-source-2026-08-16 `
  --exclude './.git/**' `
  --exclude './.venv/**' `
  --exclude './.pytest_cache/**' `
  --exclude './.ruff_cache/**' `
  --exclude './.serena/**' `
  --exclude './whisperlivekit.egg-info/**' `
  --exclude '**/__pycache__/**' `
  --exclude './chrome-extension/live_transcription.*' `
  --exclude './chrome-extension/web/**' `
  --exclude './sbom/**' `
  -o spdx-json=sbom/pikov-live-stt-source.spdx.json
```

The exclusions remove local environments, caches, generated compatibility
assets, and the SBOM output itself. They are not distributed source files.

Validation result: 420 package records, SPDX version 2.3. Syft reports
`NOASSERTION` for both `licenseDeclared` and `licenseConcluded` on all 420
records. Therefore this artifact is an inventory input for SCA, not evidence of
license compatibility or clearance.

Scope limitations:

- it does not describe the 22.3 GB local Docker image, CUDA runtime, or base
  image layers;
- it does not contain or describe a fixed revision of the runtime-downloaded
  `large-v3` model weights;
- it includes packages discoverable from all lockfiles and the initialized
  Qwen submodule, not only the default `cu129` Compose installation;
- bundled-source attributions and retained license texts are maintained in
  `../THIRD_PARTY_NOTICES.md` and `../THIRD_PARTY_LICENSES.md`.

Generate and review a separate image SBOM, transitive license inventory, model
provenance record, and vulnerability report before publishing a Docker/GHCR
image. No Docker image is released as part of this source publication.
