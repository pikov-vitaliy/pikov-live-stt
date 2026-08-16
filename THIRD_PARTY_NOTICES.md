# Third-party notices

This file records third-party code and binary assets bundled in the Pikov
LiveSTT source tree. It is an attribution and provenance record, not a complete
license analysis of every dependency installed at build or runtime. Full MIT
license texts are preserved in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md);
Apache-2.0 terms are in [LICENSE](LICENSE).

## OpenAI Whisper

- Bundled paths: `whisperlivekit/whisper/**`, except the Pikov/WhisperLiveKit
  files `whisperlivekit/whisper/val.py` and
  `whisperlivekit/whisper/assets/__init__.py`.
- Origin: [openai/whisper](https://github.com/openai/whisper) at commit
  `5f86d1d86363843179951550570367b37c5d6f78`.
- License: MIT.
- Copyright: Copyright (c) 2022 OpenAI.

The bundled copy includes source files and tokenizer/filter assets. Some source
files were modified as part of WhisperLiveKit integration; the original MIT
notice remains applicable to the derived portions.

## WhisperStreaming / LocalAgreement

- Bundled paths:
  `whisperlivekit/local_agreement/backends.py`,
  `whisperlivekit/local_agreement/online_asr.py`, and
  `whisperlivekit/local_agreement/whisper_online.py`.
- Origin: [ufal/whisper_streaming](https://github.com/ufal/whisper_streaming)
  at commit `6da90b44b7e50d79695e68166d2a2c7609c75abb`.
- License: MIT.
- Copyright: Copyright (c) 2023 ÚFAL.

## Silero VAD

- Adapted source: `whisperlivekit/silero_vad_iterator.py`.
- Bundled model assets:
  `whisperlivekit/silero_vad_models/silero_vad.jit`,
  `silero_vad.onnx`, `silero_vad_16k_op15.onnx`, and
  `silero_vad_half.onnx`.
- Origin: [snakers4/silero-vad](https://github.com/snakers4/silero-vad) at
  commit `4c00cd14be0ff5b8bd6846a6eec72741aac837f2`.
- License: MIT.
- Copyright: Copyright (c) 2020-present Silero Team.

The four bundled binary model files match the corresponding assets at the
identified source commit.

## Simultaneous Whisper backend

The code under `whisperlivekit/simul_whisper/` is an integrated derivative of
multiple sources:

- [ufal/SimulStreaming](https://github.com/ufal/SimulStreaming), represented by
  post-relicense commit `077ea37d5ab4ff98bc567e4507f140dc4e5d5ad6` —
  MIT, Copyright (c) 2025 Charles University;
- [backspacetg/simul_whisper](https://github.com/backspacetg/simul_whisper) at
  commit `ffeb3ff333026f29053d01c95a1a0524f2a41865` — Apache-2.0,
  Copyright 2024 Speech and Audio Technology LAB of Tsinghua University;
- OpenAI Whisper at the commit identified above — MIT;
- the `resize` function in `whisperlivekit/simul_whisper/eow_detection.py`,
  derived from [dqqcasia/mosst](https://github.com/dqqcasia/mosst) at commit
  `26eaaa61557aecae9e83410e7fddb90cffe2a704` — MIT,
  Copyright (c) Facebook, Inc. and its affiliates.

### SimulStreaming license chronology

WhisperLiveKit imported SimulStreaming-derived code on 1 July 2025, when that
upstream repository carried the PolyForm Noncommercial License 1.0.0. The
SimulStreaming copyright holder changed the upstream repository to the MIT
License in commit `0f63d3793ce3a0dcc026aade36e2fea82d573037` on
22 October 2025; current SimulStreaming and WhisperLiveKit distributions
identify this component as MIT-licensed. This chronology is recorded to make
the provenance reviewable; organizations requiring a formal legal conclusion
should confirm applicability to their intended use. The Pikov LiveSTT Docker
profile selects `faster-whisper` with LocalAgreement, not SimulStreaming.

## Qwen3-ASR causal submodule

- Gitlink: `third_party/qwen3-asr-causal` pinned to
  `89752586ca978d72773732422b81bf03eea2e5e2`.
- Origin: [QuentinFuxa/Qwen3-ASR-causal](https://github.com/QuentinFuxa/Qwen3-ASR-causal).
- License: Apache-2.0; the submodule contains its own `LICENSE`.
- Copyright: Copyright 2025 Quentin Fuxa.

The parent repository distributes a pinned gitlink. A recursive clone obtains
the submodule from its own repository. Qwen model weights are not bundled.

## Contributor Covenant

- Bundled path: `CODE_OF_CONDUCT.md`.
- Origin: [Contributor Covenant 3.0](https://www.contributor-covenant.org/version/3/0/),
  stewarded by the Organization for Ethical Source.
- License: [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/).

The Pikov LiveSTT copy is Adapted Material: its confidential reporting channel
was changed from the upstream maintainer's address to this repository's private
reporting form. The file retains the Contributor Covenant attribution, license
link, and an explicit indication of the Pikov LiveSTT modification. It remains
available under CC BY-SA 4.0; the Apache-2.0 grant for the project does not
replace those terms.

## Downloaded and installed components

Python packages, CUDA libraries, container base layers, and ASR model weights
are resolved separately and remain under their respective terms. In
particular, `Systran/faster-whisper-large-v3` is downloaded at runtime into the
named Docker model-cache volume; its weights are not tracked or baked into this
source repository, and the current profile does not pin a Hugging Face model
revision.

The readiness script downloads a speech fixture from `whisper.cpp` commit
`1fe009caeda75f69bc864d6370b10674e45a92bd` only when needed and verifies SHA-256
`59DFB9A4ACB36FE2A2AFFC14BACBEE2920FF435CB13CC314A08C13F66BA7860E`.
The fixture is not redistributed in Git.

Before publishing a Docker/GHCR image, generate a separate image SBOM and
license inventory covering all installed dependencies and base layers. A
source-tree SBOM alone is not evidence of transitive license clearance.
