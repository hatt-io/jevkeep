# Contributing to JevKeep

JevKeep is a TypeScript plugin for Codex. Issues and pull requests are welcome.

## Local development

Use Node.js 22 or newer:

```sh
git clone https://github.com/hatt-io/jevkeep.git
cd jevkeep
npm ci --ignore-scripts
npm run build
```

`npm run build` checks TypeScript and produces the bundled runtime and license
notices in `dist/`. Commit updated bundles with changes to runtime source or
dependencies. A clean rebuild should leave no differences:

```sh
git diff --exit-code -- dist/
```

To try a change in Codex, run `node scripts/install.mjs`, run the install command
it prints, and start a new conversation. Review changed hooks through `/hooks`.
Using the live scorer requires a Typesafe API key and sends conversation text to
Typesafe, as described in the [README](README.md#what-leaves-your-machine).

## Changes and verification

Keep pull requests focused. Describe the problem, the resulting behavior, and
how you checked it. For runtime changes, exercise the affected hook behavior
using synthetic transcripts, including relevant failure paths. Use `diff` when
checking deterministic output against another output.

Preserve the read-only transcript flow, per-session state isolation, bounded
output, and fallback to native compaction. [Architecture](docs/architecture.md)
explains those constraints.

The files under `vendor/fast-jev-compaction/` are unmodified upstream source.
When updating them, record the revision in `UPSTREAM.md` and the build script,
preserve the upstream license, and regenerate the bundle and notices.

## Reporting bugs

Include your operating system, Node and Codex versions, reproduction steps,
and the relevant diagnostic. Use synthetic conversation text. Do not include
API keys, credential files, private transcripts, or saved session state.

For a vulnerability involving credentials or private conversation data, use
[GitHub’s private vulnerability reporting](https://github.com/hatt-io/jevkeep/security/advisories/new).
