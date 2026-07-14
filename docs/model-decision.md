# Model decision record

Status: accepted for the v1 implementation, revised 2026-07-14.

## Decision

Voicebook ships one speech engine: Supertone/supertonic-3 at commit
3cadd1ee6394adea1bd021217a0e650ede09a323. The application follows the official
four-session browser architecture and pins ONNX Runtime Web 1.23.0, matching the
reference implementation that was verified in a live Chromium WebGPU session.

Chatterbox remains a follow-up benchmark for local voice cloning rather than a v1
dependency.

## Verified facts

- Supertonic 3 was released on April 29, 2026 with 31 languages, 44.1 kHz output,
  ten fixed voice styles, OpenRAIL weights, and an official browser example that
  runs four ONNX sessions through WebGPU or WASM.
  [Official repository](https://github.com/supertone-inc/supertonic),
  [primary model card](https://huggingface.co/Supertone/supertonic-3).
- The official Hugging Face Space uses direct ONNX Runtime Web sessions rather
  than a standardized Transformers.js pipeline layout. Voicebook mirrors that
  architecture inside a dedicated worker while retaining its generic engine
  contracts for future adapters.
- Resemble AI’s official browser demo runs Chatterbox through Transformers.js v4
  in a worker, supports local voice cloning, and documents roughly 1.5 GB of model
  sessions plus short per-call generation limits.
  [Official demo repository](https://github.com/resemble-ai/transformersjs-chatterbox-demo).
- The three research runs in references/ identified Supertonic as the strongest
  multilingual browser option. Live product testing then confirmed that the
  official v3 path was dramatically faster and more reliable on the reference
  machine than the discarded alternative.

## Implementation consequences

- The worker probes WebGPU, selects WebGPU or WASM explicitly, serializes model
  operations, and disposes its sessions on cancellation or GPU loss.
- Installation requires an OpenRAIL acknowledgment. Noncommercial models are
  excluded.
- Speech is split at exact sentence boundaries, generated current passage first,
  and buffered ahead without blocking playback on audio encoding.
- Read-along timing is estimated from the returned audio duration and weighted
  word/punctuation spans because the engine does not return native word timings.
- The reader exposes voice choice, not engine choice. This keeps the playback
  surface honest and removes a control that had no useful v1 decision behind it.

## Hypotheses requiring benchmarks

- Browser memory and disposal behavior must be measured across the supported
  Chrome and Edge device matrix before broad hardware claims are made.
- Estimated timing needs fixture-based listening review across languages whose
  token and punctuation patterns differ from English.
- Chatterbox may provide the desired cloning milestone, but its download, memory,
  and short generation window may make long-form continuity unacceptable on
  ordinary laptops.

## Deferred from v1

- Chatterbox voice cloning: valuable but too large to make a default without a
  published device matrix.
- OuteTTS/MMS variants with noncommercial licenses: incompatible with the
  project’s model policy.
- OCR: useful but orthogonal to proving the local speech reader core.
