# Contributing to Voicebook

Thank you for helping make private, local reading better.

## Before opening a change

1. Search existing issues and Discussions.
2. For a substantial feature or model adapter, open a proposal first so storage, licensing, browser support, and UX can be agreed before implementation.
3. Never add telemetry, remote fonts, a document-upload path, noncommercial model weights, or an unpinned model revision.

## Development

```bash
npm ci
npx playwright install chromium
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint
npm run check
npm run test:coverage
BASE_PATH=/voicebook npm run build
npm run test:e2e
```

Every edited Svelte component must pass `svelte-check` and the official Svelte autofixer without remaining issues. Domain/parser/storage/queue/timeline work must preserve at least 85% statement/line/function and 80% branch coverage.

## Pull requests

- Keep one coherent concern per PR and link an issue with `Closes #…` when appropriate.
- Include tests and describe privacy, storage, model-license, accessibility, and performance impact.
- Do not add coauthors unless they materially contributed and consent to attribution.
- Include screenshots for visual changes at 1440×900, 1280×800, and 1024×768.
- Use conventional commit titles (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) so Release Please can build useful release notes.

By contributing, you agree that your contribution is licensed under the project’s MIT license.
