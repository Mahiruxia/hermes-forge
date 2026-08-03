# Contributing to Hermes Forge

Hermes Forge is meant to be shaped in public. We welcome UI experiments, runtime integrations, safety improvements, docs, tests, platform work and small quality-of-life fixes.

## Good First Areas

- UI polish: dashboard layout, theme tokens, empty states, accessibility and responsive behavior.
- Runtime setup: clearer Hermes path detection, WSL setup, local model configuration and diagnostics.
- Security hardening: safer path validation, clearer permission prompts, better secret handling and redaction.
- Developer experience: tests, fixtures, scripts, CI, docs and release automation.
- Platform support: Windows packaging first, then macOS and Linux once the core runtime contracts are stable.

## Local Setup

```bash
npm ci
cp .env.example .env
npm run dev
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm run dev
```

## Before Opening a Pull Request

Please run:

```bash
npm run check
npm test
```

Run `npm run build` as well when your change touches Electron main process code, renderer build configuration, packaging, assets or TypeScript project settings.

## Pull Request Guidelines

- Keep PRs focused. A small, reviewable change is easier to merge than a large rewrite.
- Explain the user-facing impact and any security implications.
- Include screenshots or screen recordings for UI changes.
- Mention whether you changed permissions, file access, command execution, IPC, secrets or packaging behavior.
- Draft PRs are welcome for early design discussion.

## Community Tone

Assume good intent, explain tradeoffs, and make room for experimentation. Hermes Forge is a workshop: early ideas are useful when they are clear, testable and kind to future maintainers.
