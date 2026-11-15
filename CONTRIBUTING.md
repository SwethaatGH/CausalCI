# Contributing to CausalCI

Thanks for helping CausalCI find the commits that break builds.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Before opening a pull request

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Guidelines

- **No fabricated data.** Every metric, edge and finding must come from analyzed input. Simulated content belongs only in the clearly labeled demo.
- **Keep evidence traceable.** New risk signals must attach `EvidenceReference`s (commit SHA, file, line, snippet) and declare a detection type (`ast`, `heuristic`, `metadata`).
- **Validate at the boundary.** Request bodies and AI output go through Zod schemas in `packages/shared`.
- **Never execute imported repository code** on the host.
- **Put analysis logic in `packages/analysis`** as pure, unit-tested functions; keep `apps/api` thin.
- **Keep the language plain.** Use words a newcomer understands ("Most likely cause", "Impact map"), not internal jargon.
- **Accessibility.** Keyboard reachable, visible focus, labels on inputs, color never the only signal, reduced-motion respected.

## Adding a risk signal

1. Add the kind to `RiskSignalKind` in `packages/shared/src/types.ts`.
2. Add its weight cap and detection type to `SIGNAL_WEIGHTS` in `packages/analysis/src/risk.ts`, and mirror it in `apps/web/src/components/signal-labels.ts`.
3. Emit it with evidence in `assessCommit`.
4. Add a test in `packages/analysis/test`, and check that the demo ranking still holds.

## Commit messages

Use the imperative mood: "Add Python AST parser", not "Added…".
