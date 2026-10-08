/// <reference types="bun-types" />

// R49: ambient Bun types for the whole program — the repo runs on Bun
// (`bun run dev`, `bun scripts/…`, the desktop shell embeds Bun), and a
// dozen historical scripts import 'bun:sqlite' while agent-desktop uses the
// `Bun` global. One root-level reference pulls the full ambient set
// (bun:sqlite module declarations + the Bun global) into every tsc run.
// bun-types augments (not replaces) @types/node, so Next.js server types
// are unaffected.
