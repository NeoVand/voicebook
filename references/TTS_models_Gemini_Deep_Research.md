# **Technical Evaluation of In-Browser Text-to-Speech Models for Long-Form Audiobook Synthesis with WebGPU**

As of July 13, 2026, the landscape of browser-based machine learning has transitioned to decentralized, zero-cost, on-device execution1. Historically, implementing high-fidelity text-to-speech (TTS) pipelines required reliance on server-side architectures, exposing developers to high hosting costs, recurring token-based APIs, and user privacy concerns1. Standard cloud-based alternatives impose substantial operational overhead, with services like ElevenLabs costing approximately $0.24 per 1,000 characters and OpenAI TTS HD costing $0.03 per 1,000 characters2.  
To build a free, highly private, client-side audiobook creation tool where users paste raw markdown files and generate professional-grade audio, utilizing web-native machine learning is the most viable strategy3. Powered by the maturation of Transformers.js v4 and native WebGPU runtimes, modern browsers can compile heavy neural models directly inside the client's GPU sandbox1. This report provides a technical investigation of WebGPU-compatible TTS models, detailing their performance profiles, model topologies, and integration structures for long-form synthesis3.

## **Comparative Matrix of WebGPU-Accelerated Browser TTS Models**

The table below catalogs the prominent open-weight neural text-to-speech models optimized for ONNX Runtime Web and Transformers.js, evaluating them against performance metrics required for long-form audiobook generation.

| Model Identifier on Hugging Face | Parameter Count | Footprint & Precision Formats | Sample Rate | Core Neural Architecture | Primary Architectural Strength | Operational Limits & Context Constraints |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| onnx-community/Supertonic-TTS-ONNX \[cite: 7, 8\] | 66M to 99M9 | \~263 MB (fp32, fp16, q8, q4, q4f16)8 | 44.1 kHz7 | Speech Autoencoder \+ Flow Matching Text-to-Latent \+ ConvNeXt7 | Native 44.1kHz studio-grade output, exceptionally fast generation, supports inline expression tags9 | Limited custom stylistic flexibility; requires predetermined style embeddings7 |
| onnx-community/Kokoro-82M-v1.0-ONNX \[cite: 13\] | 82M13 | \~85 MB (Quantized q8) / \~160 MB (Full fp32)15 | 24 kHz15 | StyleTTS 2 (Style Diffusion \+ Adversarial Alignment)14 | Excellent prosody and intonation; lightweight download size; supports multi-voice linear blending15 | Limited native multilingual extension; strictly 24kHz synthesis16 |
| nsarang/voice-cloning-f5-tts \[cite: 6, 20\] | \~384M (Base)6 | \~200 MB (Optimized fp16 Transformer)6 | 24 kHz6 | Neural Flow Matching \+ Diffusion Transformer (DiT)6 | Dynamic zero-shot voice cloning from a 5–10s reference sample; highly natural pitch preservation6 | Requires auxiliary transcription models (e.g., Whisper) to align audio targets6 |
| onnx-community/OuteTTS-0.2-500M \[cite: 22\] | 500M22 | \~500 MB (fp32, q8, q4)22 | 24 kHz23 | Autoregressive Decoder-Only LLM (Qwen2 / Llama)22 | Consistent speaker profile generation saved directly as lightweight JSON configs18 | Higher latency and processing overhead due to autoregressive sampling loops24 |
| onnx-community/chatterbox-ONNX \[cite: 5\] | \~500M5 | \~1.5 GB (Distributed over 4 modular sessions)5 | 24 kHz27 | Llama-Based Sequence-to-Sequence5 | Zero-shot cloning with fine-grained expressiveness sliders5 | High VRAM consumption; maximum output constrained to 256 tokens (5–10s) per execution chunk5 |
| campwill/HAL-9000-Piper-TTS \[cite: 28\] | Variable (Small)18 | \<100 MB (fp32, q8)3 | 16 kHz to 22.05 kHz18 | End-to-End VITS (Variational Inference with Adversarial Learning)3 | Minimal execution latency on standard CPUs; highly optimized WASM execution3 | Monotonous prosody; output can sound robotic compared to diffusion architectures3 |

## **Detailed Analysis of Neural Engine Options**

Selecting the core voice generation engine for an in-browser markdown reader requires examining how each architecture processes text, manages memory, and handles long-form execution3.

### **Supertonic TTS (v3)**

Supertonic TTS represents a significant advancement in on-device speech synthesis, outputting native 44.1kHz studio-grade audio directly from its decoder without requiring separate high-frequency upsampling models10. Structurally, Supertonic avoids the computational bottlenecks of autoregressive generation by using a three-stage pipeline9:

1. A Speech Autoencoder compresses the raw waveform into continuous latent audio blocks12.  
2. A Text-to-Latent module maps the raw text characters to these latents using an optimized Flow Matching process9.  
3. A sequence-level Duration Predictor uses efficient ConvNeXt blocks to control the timing, prosody, and pacing of the output12.

This design generates speech at speeds up to 167 times faster than real-time on premium consumer hardware (such as Apple's M4 Pro)9. The model supports 31 languages and includes zero-shot voice cloning from brief reference clips10.  
For audiobook applications, its primary benefit is support for 10 inline expression tags (such as \<laugh\>, \<breath\>, and \<sigh\>), allowing developers to program natural pauses and human nuances directly into the text parsing stage10. The model weighs approximately 263 MB on the Hugging Face Hub, making it an efficient option for fast cold starts and client-side storage8.

### **Kokoro-82M**

Kokoro-82M is built on the StyleTTS 2 architecture, achieving natural prosody and voice synthesis with only 82 million parameters14. By using style diffusion to model the diverse prosody of human speech, Kokoro bypasses the monotonous and mechanical cadences typical of single-stage end-to-end systems2.  
When packaged as an 8-bit quantized ONNX file, the model footprint is only \~85 MB, allowing it to download quickly and cache locally inside the browser's IndexedDB3.  
Kokoro's runtime library, kokoro-js, supports dynamic style vector interpolation13. This allows the user interface to blend two distinct speaker profiles (for example, blending a warm female voice like af\_heart with a deep male voice like am\_adam) via linear style-embedding math13:  
![][image1]  
where ![][image2] represents the slider value on the blending interface19. This enables the generation of unique, personalized hybrid voices entirely client-side, without requiring new model downloads19.  
The primary limitation of Kokoro-82M is its native 24kHz sampling rate15. While this is clean and speech-optimized, it lacks the broader acoustic range of Supertonic’s 44.1kHz output10.

### **F5-TTS (Flow Matching with Diffusion Transformer)**

F5-TTS is a robust non-autoregressive voice-cloning system that uses a Diffusion Transformer (DiT) backbone to generate natural speech6. The model operates using a neural flow-matching design that denoises latents along straight vector fields, accelerating convergence during inference6.  
In-browser implementations (such as nsarang/voice-cloning-f5-tts) optimize the transformer to a \~200MB FP16 ONNX model6. Voice cloning is accomplished by feeding a 5–10 second reference WAV file alongside its textual transcript6. To automate this in the browser, developers can chain F5-TTS with a client-side transcription model, such as distil-whisper-small.en, using Transformers.js to transcribe the user's microphone input automatically6.  
While F5-TTS offers highly realistic voice replication, the iterative denoising process requires a set number of flow-matching steps (typically between 10 and 32 steps)6. This makes the model computationally heavier than single-pass generators like Kokoro, leading to longer processing times on lower-end client GPUs6.

### **Autoregressive Language Models: OuteTTS and Chatterbox**

OuteTTS and Chatterbox process text-to-speech by framing audio synthesis as a generative sequence task, predicting sequential acoustic tokens similarly to how Large Language Models generate text5.  
OuteTTS (0.2-500M) is built on a Qwen2 base and allows developers to extract speaker characteristics from an audio sample, save the profile as a lightweight JSON configuration, and load it dynamically to maintain vocal consistency across chapters18.  
Chatterbox TTS (0.5B parameters) offers high-fidelity zero-shot voice cloning and detailed expressiveness controls5.  
However, autoregressive models present severe challenges for long-form browser applications:

* **Footprint:** Chatterbox requires \~1.5 GB of model assets split across four distinct ONNX sessions (Embed Tokens, Speech Encoder, Language Model, and Conditional Decoder)5. This large size risks exceeding browser storage limits and causes slow first-load download times5.  
* **Context Limits:** The autoregressive sampling loop becomes computationally expensive as the context window grows. Chatterbox limits output generation to a maximum of 256 tokens per call, yielding only 5–10 seconds of speech5. For a large markdown file, this requires aggressive text splitting and complex stitch-and-rebuild routines to compile a continuous stream5.

## **Technical Stack & WebGPU Integration Architecture**

To run these models locally, the browser application must coordinate multiple technical layers, including hardware-accelerated execution runtimes, background threads, and client-side storage systems3.

┌────────────────────────────────────────────────────────────────────────────────────────┐  
│                                    CLIENT BROWSER RUNTIME                              │  
│                                                                                        │  
│  ┌───────────────────────┐                    ┌─────────────────────────────────────┐  │  
│  │   Main UI Window      ├─► \[User Input\] ───►│   Application State Store           │  │  
│  │ (Sentence Highlight)  │◄─ \[Progress/Audio\] │ (Markdown segments, Voice IDs)      │  │  
│  └───────────────────────┘                    └──────────────────┬──────────────────┘  │  
│                                                                  │                     │  
│                                           PostMessage (Comlink)  │                     │  
│                                                                  ▼                     │  
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │  
│  │   Background Web Worker Thread                                                   │  │  
│  │                                                                                  │  │  
│  │   ┌─────────────────────┐   Model Loading   ┌─────────────────────────────────┐  │  │  
│  │   │   Transformers.js   │◄─────────────────►│        IndexedDB Cache          │  │  │  
│  │   │      v4 Engine      │                   │ (Cached .onnx & voice profiles) │  │  │  
│  │   └──────────┬──────────┘                   └─────────────────────────────────┘  │  │  
│  │              │                                                                   │  │  
│  │              ▼  Inference Invocation                                             │  │  
│  │   ┌───────────────────────────────────────────────────────────────────────────┐  │  │  
│  │   │   ONNX Runtime Web (ORT-Web)                                              │  │  │  
│  │   │   ┌────────────────────────────────────┬────────────────────────────────┐ │  │  │  
│  │   │   │ WebGPU Execution Provider (EP)     │ WebAssembly Fallback (WASM)    │ │  │  │  
│  │   │   │ (FP32 / FP16 shader-f16 pipelines) │ (Multi-threaded, q8 dtypes)    │ │  │  │  
│  │   │   └────────────────────────────────────┴────────────────────────────────┘ │  │  │  
│  │   └──────────────────────────┬────────────────────────────────────────────────┘  │  │  
│  └──────────────────────────────┼───────────────────────────────────────────────────┘  │  
│                                 ▼ raw float32 samples                                  │  
│                      ┌───────────────────────────┐                                     │  
│                      │   lamejs MP3 Encoder      │                                     │  
│                      └──────────┬────────────────┘                                     │  
│                                 ▼ mono .mp3 chunk                                      │  
│                      ┌───────────────────────────┐                                     │  
│                      │  AudioContext Playback    │ ──► Device Speakers                 │  
│                      └───────────────────────────┘                                     │  
└────────────────────────────────────────────────────────────────────────────────────────┘

### **1\. WebGPU Acceleration and Precision Fallbacks**

WebGPU provides direct access to the system's graphics card from within the browser, avoiding the overhead of WebAssembly CPU processing1.  
Transformers.js v4 uses a fully rewritten C++ WebGPU runtime in partnership with ONNX Runtime Web4. This runtime optimizes operator execution, achieving a \~4x speedup for transformer layers4.

* **Shader F16 Precision:** By default, models run fastest when compiling WebGPU shaders using half-precision (fp16 or q4f16) parameters29. However, some mobile devices and graphics drivers lack shader-f16 compliance24. To maintain stability, the underlying framework must detect these hardware limitations and fall back automatically to fp32 execution or integer-quantized WASM compilation without crashing the web app24.  
* **Resource Reclamation:** Because WebGPU allocates hardware buffers on the GPU, applications must actively manage memory to prevent leaks during long generation sessions29. When closing or switching models, the application must invoke pipeline.dispose() to clear native GPU tensors and release Javascript heap memory29.

### **2\. Lifecyle Management via the ModelRegistry API**

In Transformers.js v4, the ModelRegistry API provides direct control over downloading and caching model assets4. When loading an audiobook app, downloading gigabytes of model files unexpectedly can frustrate users5. The ModelRegistry API allows the application to check asset requirements before launching:

JavaScript  
import { ModelRegistry, pipeline } from "@huggingface/transformers";

const modelId \= "onnx-community/Supertonic-TTS-ONNX";  
const modelOptions \= { dtype: "q4f16" };

// Check if the pipeline assets are already stored in IndexedDB  
const isCached \= await ModelRegistry.is\_pipeline\_cached("text-to-speech", modelId, modelOptions);

if (\!isCached) {  
  // Query all target files to calculate the total download size  
  const files \= await ModelRegistry.get\_pipeline\_files("text-to-speech", modelId, modelOptions);  
    
  const metadataPromises \= files.map(file \=\> ModelRegistry.get\_file\_metadata(modelId, file));  
  const metadataList \= await Promise.all(metadataPromises);  
    
  const totalDownloadBytes \= metadataList.reduce((acc, item) \=\> acc \+ item.size, 0);  
  const totalDownloadMB \= (totalDownloadBytes / (1024 \* 1024)).toFixed(2);  
    
  console.log(\`Initial setup requires downloading: ${totalDownloadMB} MB.\`);  
}

By querying file metadata, developers can display accurate, end-to-end progress bars to users during the initial download and setup phase4.

### **3\. Background Thread Isolation and Transferable Objects**

Executing deep learning models is computationally intensive. If run on the browser's main window thread, the user interface will freeze, preventing text selection, scrolling, and playback interactions5.  
To keep the application responsive, the entire Transformers.js inference engine must be run inside a background Web Worker5.  
Communication across thread boundaries is handled using Comlink6. To avoid the performance penalty of copying large audio buffers (which can cause noticeable audio stuttering), the worker uses **Transferable Objects**5. By transferring ownership of the underlying ArrayBuffer directly to the main thread, data transfer completes instantly with zero serialization overhead5.

## **Long-Form Processing and Streaming Pipelines**

Processing massive markdown documents requires robust chunking and streaming strategies3. Feeding an entire chapter to a model in a single execution call will exceed its token limit, consume excessive memory, or cause synthesis to fail5.

### **1\. Document Segmentation**

To handle large documents, pasted markdown files must be parsed and split into smaller, manageable chunks3:

* **Structural Division:** The document is first parsed into logical chapters using Markdown headers (such as \# and \#\#)3.  
* **Sentence-Level Chunking:** Each chapter is split into individual sentences using a DOM-based parsing approach3. Slicing on strict punctuation boundaries (such as periods, exclamation marks, and question marks) keeps text inputs small and easy to process3.  
* **Synthesizing Pacing:** Commas, semicolons, and periods are mapped to specific silent rest periods (for example, a ![][image3] pause after a sentence or a ![][image4] pause after a comma) to maintain natural narrative pacing19.

### **2\. Dynamic Streaming with TextSplitterStream**

To ensure users do not have to wait for an entire chapter to compile before listening, the system must stream generated audio progressively3.  
Using kokoro-js, developers can implement a streaming pipeline where text is processed and spoken as it becomes available13:

JavaScript  
import { KokoroTTS, TextSplitterStream } from "kokoro-js";

const modelId \= "onnx-community/Kokoro-82M-v1.0-ONNX";  
const tts \= await KokoroTTS.from\_pretrained(modelId, {  
  dtype: "q8",  
  device: "webgpu"  
});

// Create a splitter stream that chunks the document dynamically  
const splitter \= new TextSplitterStream();  
const audioStream \= tts.stream(splitter);

// Read and process the generated audio chunks asynchronously  
(async () \=\> {  
  let chunkIndex \= 0;  
  for await (const { text, phonemes, audio } of audioStream) {  
    console.log(\`Synthesizing sentence index ${chunkIndex}: "${text}"\`);  
      
    // Save the individual segment as a WAV/MP3 chunk  
    await audio.save(\`audio-segment-${chunkIndex++}.wav\`);  
      
    // Queue the audio buffer in the Web Audio API playback engine  
    playAudioBuffer(audio.toRawPCM());   
  }  
})();

// Write the pasted markdown document directly into the active stream  
splitter.write(pastedMarkdownText);

Using this streaming pipeline, the user can begin listening within seconds of pasting their markdown, while subsequent sentences are synthesized in the background3.

### **3\. Svelte 5 (Runes) vs. React Implementation Architecture**

Two open-source reference implementations illustrate how to structure this tool's architecture:

* **Svelte-Based Audiobook Generator (José Cabeda):** Built with Svelte 5 and TypeScript, this app offers a robust reference architecture for long-form reading3. It uses a DOM-based parser to preserve markdown formatting and splits text into sentence-level segments3. Synthesized audio chunks are saved directly to IndexedDB, enabling offline listening3. The playback engine supports progressive streaming, sentence-level highlighting, and clickable text elements that let users skip to and synthesize any specific sentence on demand3.  
* **React-Based F5-TTS Voice Cloner (Nima Sarang):** This implementation shows how to manage multi-speaker podcast modes and custom tensor serialization6. It uses a React Context API wrapper (ModelContext.jsx) to orchestrate Web Worker lifecycles and provides an advanced settings menu to adjust flow-matching steps and chunk sizes dynamically6.

### **4\. Audio Merging and Compressed File Export**

While browser engines can play uncompressed float arrays natively, storing hours of uncompressed WAV files can quickly exhaust device storage and memory19.  
To output portable audiobooks, the application should process and merge the generated chunks into standard compressed formats3:

1. **PCM to Int16 Conversion:** Raw 32-bit floating-point audio data is normalized and scaled to 16-bit integer values to prepare it for encoding15.  
2. **MP3 Encoding via lamejs:** Individual sentence chunks are passed to an in-browser lamejs instance, which compresses the data into MP3 frames19. Standardizing on mono-channel MP3 at 128 kbps provides an efficient file footprint (approximately 960 KB per minute of audio) while preserving high speech quality19.  
3. **M4B Audiobook Packaging:** The application can merge the sequential MP3 files into a single, cohesive M4B container, embedding metadata markers to preserve chapter boundaries and navigation3.  
4. **EPUB3 Media Overlays:** For an enhanced reading experience, developers can export an EPUB3 file that synchronizes the markdown text with the synthesized audio3. By generating SMIL (Synchronized Multimedia Integration Language) mapping files, compatible e-readers can highlight each sentence in real-time as the corresponding audio plays3.

## **Technical Recommendations for System Architecture**

For a serverless, browser-based audiobook creation tool running on WebGPU, a hybrid design combining multiple models offers the best balance of speed, voice quality, and resource usage:

1. **Vocal Customization and Quality:** Offer **Supertonic TTS (v3)** as the premium default engine10. Its 44.1kHz sampling rate and support for inline expression tags provide highly natural, expressive speech10. Provide **Kokoro-82M** as a lightweight, fast alternative, allowing users to blend speaker styles dynamically via an interactive slider15.  
2. **Custom Voice Cloning:** Integrate **F5-TTS** as an opt-in voice-cloning feature6. The model size (\~200MB) is highly efficient for on-device execution, enabling users to clone their own voices using a short microphone sample transcribed locally via Whisper6.  
3. **Memory and Storage Isolation:** Run all model execution, text splitting, and MP3 encoding inside a dedicated background Web Worker using Comlink5. Store model files and generated audio chunks inside IndexedDB to enable offline persistence and protect against browser tab crashes during long sessions3.  
4. **Progressive Playback UI:** Implement sentence-level chunking and streaming3. This ensures users can begin listening immediately after pasting a markdown file, with sentence highlighting and on-demand seeking updating the generation queue dynamically3.

#### **Works cited**

1. Transformers.js: Run AI Models Directly in the Browser \- Developers Digest, [https://www.developersdigest.tech/blog/transformers-js-guide](https://www.developersdigest.tech/blog/transformers-js-guide)  
2. Voice AI Research \- GitHub Gist, [https://gist.github.com/cedrickchee/770277bd0d368f5e682389c36f3468c2](https://gist.github.com/cedrickchee/770277bd0d368f5e682389c36f3468c2)  
3. Cabeda/audiobook-generator \- GitHub, [https://github.com/Cabeda/audiobook-generator](https://github.com/Cabeda/audiobook-generator)  
4. Releases · huggingface/transformers.js \- GitHub, [https://github.com/xenova/transformers.js/releases](https://github.com/xenova/transformers.js/releases)  
5. resemble-ai/transformersjs-chatterbox-demo \- GitHub, [https://github.com/resemble-ai/transformersjs-chatterbox-demo](https://github.com/resemble-ai/transformersjs-chatterbox-demo)  
6. nsarang/voice-cloning-f5-tts \- GitHub, [https://github.com/nsarang/voice-cloning-f5-tts](https://github.com/nsarang/voice-cloning-f5-tts)  
7. onnx-community/Supertonic-TTS-ONNX \- Hugging Face, [https://huggingface.co/onnx-community/Supertonic-TTS-ONNX](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX)  
8. square-zero-labs/Supertonic-TTS-ONNX at main \- Hugging Face, [https://huggingface.co/square-zero-labs/Supertonic-TTS-ONNX/tree/main](https://huggingface.co/square-zero-labs/Supertonic-TTS-ONNX/tree/main)  
9. Supertonic TTS: Lightning Fast On-Device Text-to-Speech System, [https://supertonic-tts.com/](https://supertonic-tts.com/)  
10. Supertone's Supertonic is just a 66M param, on-device text-to-speech engine that runs via ONNX for cross-platform inference. \- Reddit, [https://www.reddit.com/r/LocalLLM/comments/1tho03e/supertones\_supertonic\_is\_just\_a\_66m\_param/](https://www.reddit.com/r/LocalLLM/comments/1tho03e/supertones_supertonic_is_just_a_66m_param/)  
11. Supertonic 3 — Lightning-Fast, On-Device, Multilingual TTS, [https://supertonic3.github.io/](https://supertonic3.github.io/)  
12. What is Supertonic TTS?, [https://supertonictts.com/](https://supertonictts.com/)  
13. kokoro-js \- npm, [https://www.npmjs.com/package/kokoro-js?activeTab=readme](https://www.npmjs.com/package/kokoro-js?activeTab=readme)  
14. Kokoro TTS: Advanced AI Text-to-Speech Model with 82M parameters, [https://kokorottsai.com/](https://kokorottsai.com/)  
15. I built a text-to-speech utility that runs Kokoro-82M entirely in the browser (zero server costs, 100% private) using WebGPU \- Reddit, [https://www.reddit.com/r/webgpu/comments/1tuobna/i\_built\_a\_texttospeech\_utility\_that\_runs/](https://www.reddit.com/r/webgpu/comments/1tuobna/i_built_a_texttospeech_utility_that_runs/)  
16. Kokoro TTS: Lightweight 82M Browser Text-to-Speech Guide, [https://kokoroweb.app/en/blog/kokoro-tts-lightweight-browser-text-to-speech](https://kokoroweb.app/en/blog/kokoro-tts-lightweight-browser-text-to-speech)  
17. GitHub \- rhulha/StreamingKokoroJS: Unlimited text-to-speech in the Browser using Kokoro-JS, 100% local, 100% open source, [https://github.com/rhulha/StreamingKokoroJS](https://github.com/rhulha/StreamingKokoroJS)  
18. OuteTTS download | SourceForge.net, [https://sourceforge.net/projects/outetts.mirror/](https://sourceforge.net/projects/outetts.mirror/)  
19. Free AI Voice Generator \- BUT. Honestly, [https://buthonestly.io/resources/free-ai-voice-generator/](https://buthonestly.io/resources/free-ai-voice-generator/)  
20. Voice Cloning in Browser with F5-TTS \- Nima Sarang, [https://nimasarang.com/project/2025-09-28-tts/](https://nimasarang.com/project/2025-09-28-tts/)  
21. I built the first pure-.NET runner for F5-TTS (voice cloning) — no Python, just ONNX Runtime, [https://www.reddit.com/r/dotnet/comments/1uvhv3p/i\_built\_the\_first\_purenet\_runner\_for\_f5tts\_voice/](https://www.reddit.com/r/dotnet/comments/1uvhv3p/i_built_the_first_purenet_runner_for_f5tts_voice/)  
22. onnx-community/OuteTTS-0.2-500M \- Hugging Face, [https://huggingface.co/onnx-community/OuteTTS-0.2-500M](https://huggingface.co/onnx-community/OuteTTS-0.2-500M)  
23. outetts \- PyPI, [https://pypi.org/project/outetts/0.2.3/](https://pypi.org/project/outetts/0.2.3/)  
24. tantara/transformers.js-chrome: Chrome extension for running Generative AI in your browser locally \- GitHub, [https://github.com/tantara/transformers.js-chrome](https://github.com/tantara/transformers.js-chrome)  
25. OuteTTS \- Blueprints \- Mozilla.ai, [https://blueprints.mozilla.ai/tools/outetts](https://blueprints.mozilla.ai/tools/outetts)  
26. Add support for Chatterbox · Issue \#1434 · huggingface/transformers.js \- GitHub, [https://github.com/huggingface/transformers.js/issues/1434](https://github.com/huggingface/transformers.js/issues/1434)  
27. qvac/tts-onnx \- npm Package Security Analysis \- Socket.dev, [https://socket.dev/npm/package/@qvac/tts-onnx](https://socket.dev/npm/package/@qvac/tts-onnx)  
28. text-to-speech 模型- ONNX 模型库, [https://onnx.bimant.com/pipeline/text-to-speech?page=3\&sort=likes\&dir=desc](https://onnx.bimant.com/pipeline/text-to-speech?page=3&sort=likes&dir=desc)  
29. Transformers.js — Skills Registry \- Truefoundry, [https://www.truefoundry.com/skills-registry/skill/huggingface-skills-transformers-js](https://www.truefoundry.com/skills-registry/skill/huggingface-skills-transformers-js)  
30. \[Showcase\] Omnix v0.5: Local Multi-Modal Studio & Headless Inference Engine via WebGPU (Janus-Pro Native Integration) : r/tauri \- Reddit, [https://www.reddit.com/r/tauri/comments/1ues9nv/showcase\_omnix\_v05\_local\_multimodal\_studio/](https://www.reddit.com/r/tauri/comments/1ues9nv/showcase_omnix_v05_local_multimodal_studio/)  
31. Running AI models in the browser with Transformers.js \- Worldline Engineering Blog, [https://blog.worldline.tech/2026/01/13/transformersjs-intro.html](https://blog.worldline.tech/2026/01/13/transformersjs-intro.html)  
32. Building an AI-Generated Podcast I Didn't Want to Keep \- Omri Lavi, [https://omrilavi.com/blog/building-ai-podcasts-and-letting-go/](https://omrilavi.com/blog/building-ai-podcasts-and-letting-go/)  
33. Converting WAV to MP3 in JavaScript Using Lame.js \- Scribbler, [https://scribbler.live/2024/12/05/Coverting-Wav-to-Mp3-in-JavaScript-Using-Lame-js.html](https://scribbler.live/2024/12/05/Coverting-Wav-to-Mp3-in-JavaScript-Using-Lame-js.html)  
34. Converting audio to MP3 in the browser \- Javascript tutorial \- DEV Community, [https://dev.to/tiagosilvapereira/converting-audio-to-mp3-in-the-browser-javascript-tutorial-1dcm](https://dev.to/tiagosilvapereira/converting-audio-to-mp3-in-the-browser-javascript-tutorial-1dcm)  
35. zhuker/lamejs: mp3 encoder in javascript \- GitHub, [https://github.com/zhuker/lamejs](https://github.com/zhuker/lamejs)

[image1]: <data:image/png;base64,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>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAaCAYAAAAg0tunAAAB/UlEQVR4Xu2YzytEURTHD+XXRiQLWZCFDfEPIBt7CiU7WyKJP8FfYO0PsJGFUrLxF7CUBUp2WCmlcE73PnPnuOc5c98db+h+6tub+Z4z937nzHtvpgFIJBKJuvDh6Ld5gfL2jkZe+BnUFDcDWeGGQ16GhkcKT/4xatc+7q4uq2lGnYK8D5FXa3h84cnr8niDzPuJQ9SEPfr2ycir1Z1Z1DVU7iWZBtymHHj4dY9HkHfLTSUNOcARiLMxXyP7ADiSryH6ADvBvOjVHq+qyyrodXR/KQoPLw1K8jVEHSA1vzPvCXVmHz+jWp2ajx1uFICHlwYl+RqiDbAfTHMP87esT2gWe+NGAfh+0qAkX0O0AVIj3fA5Q2Bqo6g2VvORvZk89X1158PDS4OSfA1RBjgOpnGeF8CckbUE1PZp4GtJOSRfQ5QBLoLc2AJyzUcvqoObgfB99z0eUfoACanxHEyNLmUt0lq1wtdp8ngEeZvO8wPrtTueRLQBZj9f6Ft0G/WI2rM18i/sUcsDao6bNeLbj85w8sfAXB30c2ujqgPgDiqZJaju05rbZD01dOktoabBfNouq+y5hiP4HpBEQ9AghafhXaLuUcus5nLDjQCkDH+CouGHuRFA0QylUiT8CTcCKZKhdELDT6IWuBlIaIaGwL1v/jb/4h/pRCKRqDefhpy1PwXMFvUAAAAASUVORK5CYII=>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACIAAAAZCAYAAABU+vysAAABe0lEQVR4Xu2ULUsEURSGj99FMIpaFDUYDYJFEPwDCmIxbrELgh9BETSYBLEYDCaDRZPNbBGLiBgUUWyCQUH8OmfPubtn3h2d2cn3gRfuPO+duZe5u0MUidTHDueH84zFP5xz9t11E2eD0+lcXcgG7m0sD5Pr3kr7N4+kczGFmOd8glunfA+84xxwzjjbiaYAsuApuEHzWdxyplAWRRbcQknqZ1ACN5RvI0ucJ84ep5szkayJWkkXXAUviF9GCVyTbiT8Nr44o4kZRCeccRu3cN4405XW6Cd9wCIWpP4YJXBBuplAI+l9Q86lHXHNRuQ1ycQVLEj9EcochDfjr985s87V0Ew6cQ0LUr+LMgfhmAILzkleXJdASvkLejrMD4NHZI6cObq045BjOyTtrqArI8UluDHzWaQtig77rhRXpo20aHDu25wHFwjOM2Ku3TmcI7yiCMiX9cPGfaQ391TrMmkbKZkb4Eza+CExo3rfJmfOxpn4txKJRCJZ/ALvCWgk0dzv9gAAAABJRU5ErkJggg==>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACIAAAAZCAYAAABU+vysAAABaElEQVR4Xu2UPS9EQRSGX986Cg0aIn6AHyDZRKsjGq1CL5H4KIiIQisapUSi0FCJ/yBRUOg0opMoSMTXOffM3Tv3NWtm1fMkbzLznDmzk9ndATKZ9jiQfEueuBBhUPIK6z2hWtvoJg9u3OXmY81qa3Yln5IByRysT/MvViQf5HaQtqEeYtab98P6vjyXjDZekpt0PkboBkIuCW3aZwnzCyyJa8kyudBB1iWPkiPJiGSmXgZ6YU1b5BX1GywT4INcSBpu3AP7Yc83q44JWNMaF2D+nGUEPkTpmF8H0WvShZtcgPkzlhG0Zyng3iSL5Gt0wxZucwHmD1n+gf7zGiyFVVQ3pXmulyu0eExO3wX1U+RboWuHvPmtNy7plJzC1t5RrUALN+SmnU/hCvZ++Pi9vM9wwBX0wQodntMHiReXVxtyofhrmBcWJfr9vrvxOKx5tCoX8Af4jnMfWLMHe3N4jyD+rWQymUyMHzVIax/rHr1jAAAAAElFTkSuQmCC>