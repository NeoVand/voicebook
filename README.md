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

Voicebook is a local-first document reader for people who would rather listen. Add a PDF, Word document, Markdown file, plain-text file, or pasted text and Voicebook turns it into a persistent listening experience with natural speech, precise read-along highlighting, and full playback controls.

There is no account and no Voicebook server. Your documents and generated audio stay on your device.

## Get started

1. Open the [live app](https://neovand.github.io/voicebook/) in a modern browser.
2. Review the Supertonic model terms and download the voice engine once.
3. Add a document or paste text into your library.
4. Choose a voice, press play, and continue from where you left off whenever you return.

WebGPU provides the best experience. Voicebook can use a compatibility fallback on supported devices, but generation will be slower.

## What you can do

- Keep a private library of documents and reading progress across sessions.
- Listen with ten built-in voices across the languages supported by Supertonic 3.
- Change playback speed from 0.5× to 3× without chipmunk-style pitch shifting.
- Jump backward or forward ten seconds, seek through the document, or start from selected text.
- Follow narration with sentence and word highlighting, or scroll independently and return to the narrator.
- Prepare an entire document for uninterrupted listening and export completed audio as MP3.
- Use keyboard shortcuts, Media Session controls, fullscreen reading, document zoom, ten color themes, and four reading fonts.
- Reopen previously prepared documents while offline.

## Document support

| Source      | Support                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| PDF         | Text extraction, paragraph cleanup, repeated header/footer removal, and page anchors                          |
| DOCX        | Headings, paragraphs, lists, links, quotes, tables, and other semantic content                                |
| Markdown    | GFM, task lists, alerts, tables, syntax-highlighted code, KaTeX math, Mermaid diagrams, images, and safe HTML |
| TXT         | BOM-aware UTF-8 text import                                                                                   |
| Pasted text | Plain text or automatically detected Markdown                                                                 |

Scanned PDFs need OCR and are reported clearly instead of producing an empty or garbled document.

## The reader

The desktop reader keeps the document at the center, its outline beside it, and a compact playback strip along the bottom. The timeline shows what has been listened to, what audio is already cached, and what Voicebook is currently preparing. On smaller screens the same controls are reorganized into a phone-friendly player and navigation drawer.

Useful shortcuts:

| Key                         | Action                      |
| --------------------------- | --------------------------- |
| <kbd>Space</kbd>            | Play or pause               |
| <kbd>J</kbd> / <kbd>L</kbd> | Back or forward ten seconds |
| <kbd>[</kbd> / <kbd>]</kbd> | Slower or faster playback   |

## Local speech

Voicebook uses **Supertonic 3** through ONNX Runtime in a dedicated browser worker. The model is downloaded from Hugging Face only after you accept its OpenRAIL-M terms. Once installed, speech generation runs locally with WebGPU acceleration when available.

Generation quality is adjustable from 2 to 16 steps, with 10 steps as the default. Voicebook generates the current passage first, buffers upcoming passages, and stores generated audio locally so it does not need to repeat work.

## Private by design

- Documents are processed in the browser and are never uploaded to Voicebook.
- Books, settings, and progress are stored in IndexedDB.
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
