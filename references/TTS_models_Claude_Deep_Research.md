# In-Browser TTS Models for an Audiobook Creator App (Transformers.js + WebGPU, July 2026)

## TL;DR
- **Kokoro-82M remains the single best default for a free, client-side audiobook app**: Apache-2.0, ~86–326 MB depending on quantization, 54 voices across 9 languages, a mature `kokoro-js` wrapper with a built-in streaming text-splitter, and confirmed WebGPU support. Nothing else matches its quality-per-megabyte for long-form English narration that runs 100% in the browser.
- **The viable browser-native field is small**: only Kokoro, Kitten TTS, Piper, Supertonic, OuteTTS, Parler-TTS, and (newly) Chatterbox and F5-TTS actually run client-side via Transformers.js/onnxruntime-web + WebGPU. The most-hyped 2025–26 models (Orpheus, Sesame CSM, Dia, Zonos, Fish Speech, XTTS-v2, VibeVoice-large) are **PyTorch/GPU-server-only** with no real browser port.
- **Best architecture for your app**: a multi-model picker with Kokoro (default, best quality), Piper (fastest/most voices, WASM-only fallback for Safari), and optionally Chatterbox (voice cloning, ~1.5 GB) — chunk text by sentence with `TextSplitterStream`, run inference in a Web Worker, stream audio chunk-by-chunk, and cache models in IndexedDB.

## Key Findings

### 1. Kokoro TTS status (mid-2026)
- **Current model**: `hexgrad/Kokoro-82M` (v1.0, released Jan 27, 2025) is still the flagship. No larger successor from hexgrad as of mid-2026; the ecosystem has grown *around* it — language fine-tunes (e.g., German `kikiri`/`Godelaune` ONNX builds), timestamped exports, CoreML/MLX ports — rather than superseding it. A 303-point Hacker News thread on July 8, 2026 shows Kokoro is still the community reference ~1.5 years post-release.
- **Browser path**: `onnx-community/Kokoro-82M-v1.0-ONNX` + the `kokoro-js` npm package (by Xenova/Hugging Face). WebGPU is fully supported (`device: "webgpu"`, recommended `dtype: "fp32"`); WASM fallback uses `dtype: "q8"`.
- **Quantization footprints**: fp32 ≈ 326 MB, q8 ≈ 92 MB, q8f16 ≈ 86 MB, q4 ≈ 154 MB. Context window is 512 tokens (510 usable). Output is 24 kHz.
- **Voices**: 54 preset voices across 9 languages (American/British English, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese, Mandarin). Voice IDs follow `[lang][gender]_name` (e.g., `af_heart` = American Female "Heart", the default; `af_bella`, `am_michael`, `bf_emma`). Grade-A voices (Heart, Bella, Nova) are recommended for narration. Voice blending is supported by several wrappers.
- **License**: Apache 2.0 — fully commercial, no restrictions. Ideal for a free public tool.
- **Streaming**: `kokoro-js` ships a `TextSplitterStream` that splits on punctuation and emits `{text, phonemes, audio}` chunks as text is pushed — purpose-built for long text.

### 2. New/emerging models & their real browser status
**Confirmed browser-capable (ONNX + Transformers.js/onnxruntime-web + WebGPU):**
- **Kokoro-82M** — gold standard, above.
- **Kitten TTS Nano** (`KittenML`, 15M params, ~24–25 MB, Apache 2.0) — 8 expressive voices, English. Runs via transformers.js/ONNX Runtime Web with experimental WebGPU (WASM fallback). Note: the int8 "Mini" variant does NOT run on WebGPU (unsupported quantized ops MatMulInteger/ConvInteger); use the FP32 Nano for WebGPU. Lightest option; quality "good/C+", weaker on rare words.
- **Piper** (VITS, ~75 MB, MIT) — 904 LibriTTS voices (25 curated in most demos), English-focused but multilingual voices exist. Runs **WASM-only (no WebGPU)**, 3–5× realtime on CPU, works in every browser including Safari. Quality "good/C+" but can sound robotic on long passages. `de_DE-thorsten-high` is genuinely audiobook-grade among non-English voices.
- **Supertonic** (`onnx-community/Supertonic-TTS-ONNX`, 66M in v2 / 99M in v3; sample code MIT, weights OpenRAIL-M) — multilingual (5 langs in v2; **Supertonic 3, released 2026-04-29, expands to 31 languages**), fixed-voice, and extremely fast. Its official README benchmark reports **RTF ≈ 0.006 on M4 Pro WebGPU (≈167× real-time), peak 2,509 chars/sec, RTF 0.005 on RTX 4090 and 0.012 on M4 Pro CPU** (2-step inference). Official `text-to-speech` pipeline support in Transformers.js; strong text normalization for numbers/currency/units.
- **OuteTTS-0.2-500M** (`onnx-community/OuteTTS-0.2-500M`, CC-BY-NC-4.0) — LLM-based (Qwen2.5-0.5B backbone), the first WebGPU TTS demo Xenova shipped (`webml-community/text-to-speech-webgpu`). Voice cloning via speaker profiles. **License is non-commercial (CC-BY-NC), so it is unsuitable for a monetized free app.**
- **Parler-TTS** (Apache 2.0) — officially supported architecture in Transformers.js with ONNX exports; prompt-controlled voice via text description.
- **Chatterbox** (Resemble AI, 0.5B Llama backbone, MIT) — **NEW in Transformers.js v4**: `onnx-community/chatterbox-ONNX` with an official Resemble-AI browser demo (`resemble-ai/transformersjs-chatterbox-demo`). Runs 100% client-side with WebGPU, supports zero-shot voice cloning from 5–10s audio and an expressiveness slider. **Caveats: ~1.5 GB download; `max_new_tokens: 256` caps output to ~5–10s per call (heavy chunking required); no paralinguistic tags in the ONNX port; 4 ONNX sessions (embed_tokens, speech_encoder, q4/q4f16 language_model, conditional_decoder).**
- **F5-TTS** (browser demo by Nima Sarang, Sept 2025, updated Nov 2025) — in-browser voice cloning via WebGPU/ONNX, plus a multi-speaker "podcast mode." Flow-matching DiT; paper RTF ~0.15 on a reference RTX 3090 (~1.5s per 10s audio) but slower in-browser, and degrades after ~20s of output. MIT code. Better as a voice-clone toy than a whole-book narrator.
- **VibeVoice-0.5B-Realtime only** — a single community ONNX conversion (`FluffyBunnies/vibevoice-onnx-v2`, ~969 MB quantized) with a `demo.html` exists; the flagship 1.5B/7B are server-only. MIT weights, but Microsoft states "research only" and pulled the original TTS code over misuse concerns.
- **MeloTTS** (MIT) — VITS, ONNX-convertible and runnable client-side via onnxruntime-web/sherpa-onnx, but no polished Transformers.js WebGPU space.

**Frequently discussed but PyTorch/server-only (NO working browser port as of mid-2026):**
- **XTTS-v2** (Coqui) — Coqui Public Model License, non-commercial; ONNX export unresolved.
- **Orpheus TTS** (Canopy, 3B) — Apache 2.0, but 3B and no ONNX/browser port; open transformers.js feature request unfulfilled.
- **Sesame CSM-1B** — Apache 2.0 (gated), PyTorch/CUDA only.
- **Zonos** (Zyphra) — Apache 2.0, CUDA-only.
- **Dia** (Nari Labs, 1.6B) — Apache 2.0, server-only (ZeroGPU Space).
- **Fish Speech / OpenAudio S1** — weights CC-BY-NC-SA (non-commercial); PyTorch only.
- **Vui** (Fluxions) — Apache 2.0 but server-side inference with a browser UI, not client-side.

### 3. Quality & reputation
- Kokoro **hit #1 on the TTS Arena leaderboard at its v0.19 launch, beating models 10–100× its size** — per review coverage it defeated XTTS (467M params) and MetaVoice (1.2B). It is widely rated "sounds like a real person" for neutral long-form narration and is placed ahead of Google WaveNet and Amazon Polly Neural in informal blind tests. On the more recent TTS Arena V2 (as reported by OfflineTTS), **Kokoro-82M v1.0 ranks 32nd overall (Elo 1056.2, 54.4% win rate over 5,368 appearances, CI ±9)**; Artificial Analysis's Speech Arena similarly lists it at Elo ~1060 and ranks Step Audio EditX (Elo ~1118) and Fish Audio S2 Pro (~1110) as higher — but those are server-only, so Kokoro remains the top *browser-native* option.
- **Chatterbox** is the most-used open TTS project — per GenMediaLab it has **24,000+ GitHub stars, over 1 million Hugging Face downloads, and was trained on over 500,000 hours of audio**. Its headline "beats ElevenLabs" claim comes from Resemble AI's own Podonos blind test: **63.75% of listener ratings favoured Chatterbox over ElevenLabs across 8 samples, but the overall mean was –0.64 on a –2…+2 scale (negative = ElevenLabs preferred), i.e., mixed across samples** (zero-shot, 7–20s reference clips, no post-processing). Treat as "very competitive," not settled.
- Community consensus (r/LocalLLaMA, Hacker News): "stack, don't pick" — Kokoro for fast/efficient narration, Chatterbox when premium quality/cloning matters. A known Kokoro quirk: it stumbles on isolated single words (e.g., "six" → "ah-six-ah").

### 4. Practical implementation for long text ("read the whole book")
The established best-practice pattern (used by `rhulha/StreamingKokoroJS`, `Cabeda/audiobook-generator`, and `epubplayer.com`):
1. **Parse & segment**: parse markdown/EPUB into chapters, then split into sentences (DOM-aware for markup). Use a splitter that respects abbreviations ("Mr.", "Dr.") — spaCy-style, the `TextSplitterStream` in kokoro-js, or the `SentenceChunker` shared in Xenova's HF thread. Keep chunks under the model's token limit (Kokoro: 510 tokens; Chatterbox: chunk to ~5–10s of speech).
2. **Web Worker**: run all inference off the main thread (prevents UI freeze — a common mistake called out even in official demos).
3. **Progressive/streaming playback**: generate audio per segment and start playing the first chunk while later chunks generate; queue them seamlessly. Kokoro-js `.stream()` emits per-chunk audio for exactly this.
4. **Caching & resume**: cache the model in IndexedDB (automatic after first download; Kokoro ~5–10s first load for ~82 MB), cache generated audio, and persist playback position per book.
5. **Export**: concatenate WAV/MP3 segments into an M4B/MP3 on export.

Reference projects to learn from: **`rhulha/StreamingKokoroJS`** (100% client-side unlimited TTS), **`Cabeda/audiobook-generator`** (Svelte; EPUB/PDF/HTML/TXT; Kokoro+Piper+Web Speech; sentence highlighting; progressive playback; MIT), **`epubplayer.com`** (full player, IndexedDB, offline, WebGPU), and the multi-model **`clowerweb/tts-studio`** (Kokoro+Kitten+Piper switcher with a unified Web Worker). Python references with good chunking logic (not browser): `audiblez`, `abogen` (spaCy sentence splitting), `pdf-narrator` (<510-token chunking), `epub2tts-kokoro`.

### 5. Comparison table (ranked for audiobook/long-form narration)

| Rank | Model | Browser feasibility | Quality (narration) | Size / download | Voices | License | Verdict for your app |
|---|---|---|---|---|---|---|---|
| 1 | **Kokoro-82M v1.0** | ✅ WebGPU + WASM, `kokoro-js` | Best-in-class for size (A/A-) | 86–326 MB (q8/fp32) | 54, 9 langs | Apache 2.0 | **Default. Best quality-per-MB; streaming built in.** |
| 2 | **Piper** | ✅ WASM only (no WebGPU) | Good (C+), clear but flatter | ~75 MB | 904 (25 curated) | MIT | Universal/Safari fallback; huge voice variety. |
| 3 | **Chatterbox** | ✅ WebGPU (v4, official demo) | Excellent + voice cloning | ~1.5 GB | Zero-shot clone + presets | MIT | Optional "premium/clone" mode; heavy, ~5–10s output cap. |
| 4 | **Supertonic** | ✅ WebGPU + WASM | Good (B), extremely fast | ~66–99M params | 10 styles, up to 31 langs | MIT code / OpenRAIL-M weights | Fast multilingual alt; fixed-voice. |
| 5 | **Kitten TTS Nano** | ✅ WebGPU (FP32) + WASM | Good (C+), lightest | ~24 MB | 8 | Apache 2.0 | Best for low-end/mobile devices. |
| 6 | **OuteTTS-0.2-500M** | ✅ WebGPU | Good, cloning | ~500M params | presets + cloning | CC-BY-NC-4.0 | ⚠️ Non-commercial license — avoid if monetized. |

### 6. Transformers.js / WebGPU updates that matter
- **Transformers.js v3 (Oct 2024)** introduced WebGPU (`device:'webgpu'`), up to ~100× faster than WASM, 120+ architectures and 1,200+ ONNX models — this is what made Kokoro-in-browser real.
- **Transformers.js v4 (2026, on NPM)** is the big one: a completely rewritten **C++ WebGPU runtime** (built with the ONNX Runtime team), ~200 architectures, WebGPU now works in **Node/Bun/Deno** too, esbuild build system, models >8B supported, a standalone `@huggingface/tokenizers` package, and — critically for you — **Chatterbox was added as a v4-supported architecture**. Use `@huggingface/transformers` v4.x (package name `@huggingface/transformers`, **not** the deprecated `@xenova/transformers` v2 which lacks WebGPU).
- WebGPU practicalities: Chrome/Edge 113+ are most reliable; Firefox behind a flag (`dom.webgpu.enabled`); Safari experimental. Always provide a WASM fallback. Serve over HTTPS/localhost; for WASM multithreading set COOP/COEP headers. Note WebGPU's CPU→GPU transfer overhead means very short utterances can be slower than WASM — but for long audiobook chunks WebGPU wins. Kokoro on a WebGPU M4 MacBook generates roughly 1.5–2× real-time.

## Recommendations
**Stage 1 (MVP):** Ship Kokoro-82M via `kokoro-js` on `onnx-community/Kokoro-82M-v1.0-ONNX`, WebGPU with `dtype:"fp32"`, WASM fallback `dtype:"q8"`. Use `TextSplitterStream` + a Web Worker + progressive playback. Expose ~10 Grade-A/B English voices (af_heart, af_bella, af_nova, am_michael, am_adam, bf_emma, bm_george, etc.). Cache in IndexedDB. This alone satisfies "beautiful voice, whole book, free, client-side."

**Stage 2 (multi-model — your stated goal):** Add a model picker. Add **Piper** (MIT, WASM-only) as the universal/Safari fallback and for voice variety; add **Supertonic** or **Kitten** for speed/low-end devices. Mirror the `clowerweb/tts-studio` architecture (unified worker, per-model voice lists, WebGPU toggle).

**Stage 3 (premium/cloning):** Optionally add **Chatterbox** (MIT) behind a "high quality / clone a voice" toggle, with a clear ~1.5 GB download warning and aggressive sentence-chunking (its ~5–10s output cap makes chunking mandatory).

**Licensing guardrail:** Restrict default/always-on models to Apache/MIT (Kokoro, Piper, Kitten, Chatterbox, Supertonic sample code). **Avoid OuteTTS (CC-BY-NC), Fish/OpenAudio (CC-BY-NC-SA), and XTTS-v2 (CPML)** for a public tool, and treat VibeVoice's "research only" framing as a red flag. Note Supertonic's weights are OpenRAIL-M (use-restrictions apply even though it's free).

**Benchmarks that would change the plan:** If a Kokoro v2 or a new Apache/MIT sub-200M model with clearly higher MOS ships with an ONNX/WebGPU export, promote it to default. If WebGPU adoption in your user base is low (lots of Safari/mobile), lean harder on Piper (WASM). If users demand cloning, Chatterbox becomes primary despite its size.

## Caveats
- Several quality claims are vendor- or blog-sourced. Chatterbox's "63.75% beats ElevenLabs" is Resemble AI's own Podonos study and was mixed across samples (overall mean –0.64). Kokoro's Arena rankings come from community arenas (TTS Arena V1/V2, Artificial Analysis Speech Arena), not peer-reviewed benchmarks, and its ranking has slipped as newer server-only models arrived.
- Kokoro's 512-token context is small; robust sentence chunking is mandatory for books, and it occasionally mangles isolated single words.
- WebGPU is still "experimental" in non-Chromium browsers; real-world reliability varies by GPU/driver, and StreamingKokoroJS has "mixed reports on reliability" on HN.
- Chatterbox browser port: ~1.5 GB first load and ~5–10s per generation are real constraints for book-length content.
- Model sizes/quant figures are from model cards and aggregators (PromptLayer, aimodels.fyi) and may vary slightly by export. Supertonic's parameter count (66M vs 99M) differs between v2 and v3.