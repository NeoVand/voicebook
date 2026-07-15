# Third-party notices

Voicebook's original source is licensed under MIT. Its dependency lockfile records the complete dependency graph and exact runtime versions.

The following runtime components require prominent source and license notices:

## Mediabunny

- Purpose: WebCodecs-backed mono Opus/WebM encoding.
- Version: 1.50.8.
- Source: <https://github.com/Vanilagy/mediabunny>
- License: Mozilla Public License 2.0, <https://www.mozilla.org/MPL/2.0/>.
- Voicebook modifications: none; consumed as an npm dependency.

## SoundTouchJS AudioWorklet

- Purpose: pitch-preserving playback-rate changes.
- Version: 2.1.0.
- Source: <https://github.com/cutterbl/SoundTouchJS>
- License: Mozilla Public License 2.0, <https://www.mozilla.org/MPL/2.0/>.
- Voicebook modifications: none; consumed as an npm dependency.

## Supertonic browser inference reference

- Purpose: reference architecture for Supertonic 3 text processing and its four-session ONNX inference sequence.
- Source revision: `dff55dc00064c398736080c78195f577527832ae`.
- Source: <https://github.com/supertone-inc/supertonic/tree/main/web>
- License: MIT, <https://github.com/supertone-inc/supertonic/blob/main/LICENSE>.
- Voicebook modifications: reimplemented as typed worker-owned adapter code with pinned Hugging Face assets, progress reporting, browser cache management, cancellation integration, and reader timing output.

## Mermaid

- Purpose: local rendering of fenced Mermaid diagrams in imported Markdown documents.
- Version: 11.16.0.
- Source: <https://github.com/mermaid-js/mermaid>
- License: MIT, <https://github.com/mermaid-js/mermaid/blob/develop/LICENSE>.
- Voicebook modifications: none; loaded on demand as an npm dependency and rendered with Mermaid's strict security mode.

## Tabler Icons

- Purpose: outlined GitHub brand icon in the application header.
- Source: <https://github.com/tabler/tabler-icons/blob/main/icons/outline/brand-github.svg>.
- License: MIT, <https://github.com/tabler/tabler-icons/blob/main/LICENSE>.
- Voicebook modifications: packaged as a small local Svelte component with configurable size and stroke width.

Other important runtime projects include Transformers.js (Apache-2.0), PDF.js (Apache-2.0), Mammoth.js (BSD-2-Clause), Unified/remark (MIT), and idb (ISC). Model artifacts retain their own licenses and are not redistributed by this repository.
