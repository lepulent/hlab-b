# hlab-b (pacman)

This repo is a trivial Vite + vanilla TypeScript canvas app used as a toolchain boilerplate (typecheck, lint, format, unit tests, e2e tests, and infra scaffolding), not a real game; run `npm run check` to verify the full green pipeline (format, lint, typecheck, knip, unit tests) and `npm run test:e2e` for the Playwright/axe suite; infra is defined in `sst.config.ts` for AWS profile `FuturatorClaude` in region `eu-central-1` and is not deployed by this boilerplate. To reset to boilerplate: see the lab README.

Built inside the Mycelium SDD harness lab.
