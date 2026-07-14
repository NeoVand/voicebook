# Architecture

Voicebook is a browser-only SvelteKit 5 static application. Routes are finite (`/`, `/read?document=…`, and `/settings`) because document identifiers live in IndexedDB rather than the filesystem router.

## Data flow

1. An importer produces a semantic `NormalizedDocument` with source anchors.
2. Sentence/clause segmentation creates stable per-block `SpeechSegment` IDs and exact word offsets.
3. Metadata is stored in the versioned `voicebook-v1` IndexedDB database. Original files and audio prefer `voicebook/` OPFS paths, with IndexedDB Blob fallback.
4. The player asks for the current segment, then plans three future segments. A seek cancels stale requests and makes the destination current.
5. One dedicated worker owns one pinned model at a time and serializes load/synthesis/disposal operations.
6. PCM is encoded to 64-kbps mono Opus/WebM when WebCodecs is available, otherwise 16-bit WAV.
7. AudioBuffers feed a SoundTouch AudioWorklet for pitch-preserving tempo changes. The global timeline maps semantic positions into segment-local seconds.

## Storage boundaries

- Cache Storage: versioned app shell and same-origin runtime assets only.
- Model asset cache: pinned Hugging Face artifacts used by the worker's ONNX sessions.
- IndexedDB: typed document metadata, settings, audio metadata, and Blob fallback.
- OPFS: imported originals and generated audio.

Playback rate is deliberately absent from audio cache keys. Model repository/revision, backend, dtype, voice, normalized text, and generation settings are present.

## Failure behavior

- Textless PDFs return a specific OCR-not-yet-supported state.
- WebGPU absence selects WASM; an explicit WebGPU request fails with an actionable message.
- GPU-loss-like errors dispose the active model and reject the current request.
- Canceled jobs cannot enter storage, and missing/corrupt OPFS audio metadata is reconciled away for regeneration.
- Storage persistence, quota, cleanup, and eviction risk are visible in Settings.
