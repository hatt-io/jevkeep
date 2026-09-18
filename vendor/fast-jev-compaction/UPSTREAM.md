# Vendored source

Source: https://github.com/tamaratran/fast-jev-compaction

Commit: `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`

The files `src/types.ts`, `src/request.ts`, `src/state.ts`, `src/compact.ts`,
and `LICENSE` are unmodified upstream files. Only library code is vendored.
The production bundle uses upstream request construction, response parsing,
default limits, token estimation, and state fitting. Codex-specific parsing,
excerpt questions, bounded scheduling, packing, and persistence live in `src/`.
