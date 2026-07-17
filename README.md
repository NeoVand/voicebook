<p align="center">
  <img src="./src/lib/assets/favicon.svg" width="88" height="88" alt="Voicebook logo" />
</p>

<h1 align="center">Voicebook</h1>

<p align="center">
  Turn documents into expressive, private speech—entirely in your browser.
</p>

<p align="center">
  <a href="https://neovand.github.io/voicebook/"><strong>Open Voicebook</strong></a>
  ·
  <a href="#what-you-can-do">Features</a>
  ·
  <a href="#run-it-locally">Run locally</a>
</p>

<p align="center">
  <a href="https://github.com/NeoVand/voicebook/actions/workflows/ci.yml"><img src="https://github.com/NeoVand/voicebook/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/NeoVand/voicebook/actions/workflows/pages.yml"><img src="https://github.com/NeoVand/voicebook/actions/workflows/pages.yml/badge.svg" alt="Deployment status" /></a>
  <a href="https://github.com/NeoVand/voicebook/releases"><img src="https://img.shields.io/github/v/release/NeoVand/voicebook?display_name=tag&sort=semver" alt="Latest release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-78a98f.svg" alt="MIT license" /></a>
</p>

Voicebook is a local-first document reader for people who would rather listen. Add a PDF, Word document, Markdown file, plain-text file, or pasted text and Voicebook turns it into a persistent listening experience with natural speech, precise read-along highlighting, and full playback controls — including the parts text-to-speech normally mangles: a language model rewrites equations, tables, diagrams, images, and code into words a voice can actually speak.

There is no account and no Voicebook server. Your documents and generated audio stay on your device, and everything works with free on-device models — or your own API keys when you want premium voices and smarter descriptions.

## Get started

1. Open the [live app](https://neovand.github.io/voicebook/) in a modern browser.
2. Choose how Voicebook reads: download the on-device engines once (voice + language model), or paste an API key for premium engines — mix freely, change anytime in Settings.
3. Add a document or paste text into your library.
4. Press play, and continue from where you left off whenever you return.

WebGPU provides the best experience for the on-device engines. Voicebook can use a compatibility fallback for speech on supported devices, but generation will be slower.

## What you can do

- Keep a private library of documents and reading progress across sessions.
- Hear equations, tables, diagrams, images, and code as spoken descriptions — generated on-device or by Claude, GPT, or Gemini with your key, editable per construct, in Concise, Balanced, Educational, or fully custom styles.
- Listen with ten built-in voices across the languages supported by Supertonic 3, or bring an ElevenLabs key for studio voices with native word timing.
- Change playback speed from 0.5× to 3× without chipmunk-style pitch shifting.
- Jump backward or forward ten seconds, seek through the document, or start from any passage with a click.
- Follow narration with sentence and word highlighting, or scroll independently and return to the narrator. Links are never read aloud as letter soup.
- Prepare an entire document for uninterrupted listening and export completed audio as MP3.
- Use keyboard shortcuts, Media Session controls, fullscreen reading, document zoom, ten color themes, and four reading fonts — with a built-in contextual tour on every surface.
- Reopen previously prepared documents while offline.

## Document support

| Source      | Support                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| PDF         | Structured extraction to Markdown (headings, tables, math) via LiteParse, with a text-layer fallback          |
| DOCX        | Headings, paragraphs, lists, links, quotes, tables, and other semantic content                                |
| Markdown    | GFM, task lists, alerts, tables, syntax-highlighted code, KaTeX math, Mermaid diagrams, images, and safe HTML |
| TXT         | BOM-aware UTF-8 text import                                                                                   |
| Pasted text | Plain text or automatically detected Markdown                                                                 |

Scanned PDFs need OCR and are reported clearly instead of producing an empty or garbled document.

## The reader

The desktop reader keeps the document at the center, its outline beside it, and a compact playback strip along the bottom. The wave button holds everything about audio (voice, whole-document preparation, MP3 export, cache); the brain button controls the spoken descriptions. The timeline shows what has been listened to, what audio is already cached, and what Voicebook is currently preparing. Equations, diagrams, tables, and code highlight while they are spoken, and each carries an expandable panel where you can read, edit, or regenerate its spoken text. On smaller screens the same controls are reorganized into a phone-friendly player and navigation drawer — and the help button gives a guided tour of whichever page you are on.

Useful shortcuts:

| Key                         | Action                      |
| --------------------------- | --------------------------- |
| <kbd>Space</kbd>            | Play or pause               |
| <kbd>J</kbd> / <kbd>L</kbd> | Back or forward ten seconds |
| <kbd>[</kbd> / <kbd>]</kbd> | Slower or faster playback   |

## Speech engines

The free on-device engine is **Supertonic 3** through ONNX Runtime in a dedicated browser worker. The model is downloaded from Hugging Face only after you accept its OpenRAIL-M terms; once installed, speech generation runs locally with WebGPU acceleration when available. Generation quality is adjustable from 2 to 16 steps, with 10 steps as the default. Voicebook generates the current passage first, buffers upcoming passages, and stores generated audio locally so it does not need to repeat work.

Prefer premium voices? Paste an **ElevenLabs** API key and pick any of your voices — no download, native word-level timing for read-along highlighting, and the economical Flash v2.5 model by default.

## Spoken descriptions

A language model turns the constructs text-to-speech cannot read — LaTeX equations, tables, Mermaid diagrams, images, code fences — into short spoken prose, generated in the background while you listen and cached with the document.

- **On-device**: LFM2.5 1.2B runs on your GPU, free and private (desktop WebGPU required).
- **Bring your own key**: Claude, GPT, or Gemini write the descriptions instead — and can describe embedded images from the pixels.
- **Styles**: Concise states things, Balanced is the tuned default, Educational explains what equations mean, and Custom exposes every prompt for editing.
- Every description is editable and regenerable per construct, and deterministic fallbacks speak immediately until (or instead of) a model.

## Private by design

- Documents are processed in the browser and are never uploaded to Voicebook.
- Books, settings, and progress are stored in IndexedDB.
- API keys are stored only in this browser and sent only to the provider they belong to.
- Original files and generated audio use browser-managed on-device storage.
- Model installation contacts Hugging Face; normal reading does not require a Voicebook backend.
- There is no account, analytics, advertising, or telemetry.

Everything Voicebook stores can be reviewed and removed from the app’s settings.

## Run it locally

Voicebook requires Node.js 24 or newer and npm.

```bash
git clone https://github.com/NeoVand/voicebook.git
cd voicebook
npm ci
npm run dev
```

Then open the local URL printed by Vite.

To run the project checks:

```bash
npm run quality
npx playwright install chromium
npm run test:e2e
```

To reproduce the GitHub Pages base path locally:

```bash
BASE_PATH=/voicebook npm run build
npm run preview:pages
```

Open `http://127.0.0.1:4173/voicebook/`.

## Current limitations

Voicebook is under active development. OCR for scanned documents, legacy `.doc`, EPUB and HTML import, cloud sync, and voice cloning are not available yet. Large local models are demanding on memory, so phones and older computers may generate speech more slowly than desktop WebGPU systems.

## License

Voicebook is available under the [MIT License](./LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
