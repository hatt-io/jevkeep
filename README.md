# JevKeep

[![Build](https://github.com/hatt-io/jevkeep/actions/workflows/build.yml/badge.svg)](https://github.com/hatt-io/jevkeep/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)

**A Codex plugin that preserves useful conversation excerpts alongside the summary after context compaction.**

When a conversation gets long, Codex condenses earlier messages into a summary to make room for more work. That summary can lose exact details: a command that failed, a file path, an error message, or a constraint you gave earlier.

JevKeep selects useful passages before compaction and restores their original text afterward. Codex continues with its own summary plus those excerpts. This works with both manual and automatic compaction.

The idea comes from [tamaratran’s **fast-jev-compaction**](https://github.com/tamaratran/fast-jev-compaction), originally built for **Claude Code**. JevKeep adapts the approach for Codex and reuses parts of that project’s MIT-licensed library. [Credits ↓](#credits)

## How it works

1. **Before compaction**, JevKeep reads the conversation and asks Jev, a relevance-scoring model accessed through the Typesafe API, which excerpts still matter to the current task.
2. **Codex creates its summary** using its normal compaction process.
3. **After compaction**, JevKeep restores selected excerpts as additional context, with labels showing their original roles and tool sources.

Selected text stays verbatim. Large excerpts may keep only the beginning and end, with an explicit omission marker. Each restored packet is limited to **24,000 UTF-8 bytes**.

If credentials are missing or scoring fails, Codex’s normal compaction continues.

## Getting started

You need **Node.js 22+**, the **Codex CLI** with plugin and compaction-hook support, and a **Typesafe API key**. Node must be available on the PATH used by Codex, including desktop launches.

### 1. Install

```sh
git clone https://github.com/hatt-io/jevkeep.git
cd jevkeep
node scripts/install.mjs
codex plugin add jevkeep@personal
```

The runtime is already bundled, so installation needs no `npm install` or build step. The installer copies the plugin to `~/plugins/jevkeep` and registers it in your personal marketplace. If your marketplace uses a different name, run the command printed by the installer.

### 2. Add your API key

For the CLI, set `TYPESAFE_API_KEY` in the environment where you launch Codex.

For the desktop app, save the key in `~/.config/jevkeep/config.json`:

```json
{
  "TYPESAFE_API_KEY": "your Typesafe API key"
}
```

On macOS/Linux, create the directory with permissions `700` and set the file to `600`. The file must belong to your user and cannot be a symlink. The environment variable takes precedence over the file. Keep credentials outside the repository and plugin folder.

### 3. Enable the hooks

Open **`/hooks` in Codex**, review and trust JevKeep’s two hooks, then start a new conversation. Hook trust is required by [Codex](https://learn.chatgpt.com/docs/hooks); installing a plugin alone does not enable its hooks.

Once configured, JevKeep runs whenever Codex compacts that conversation.

## What leaves your machine

JevKeep sends **conversation text, tool inputs, and textual tool results** to the Typesafe API at `https://api.typesafe.ai/v1/systemone`, using the `jev-latest` model. That text can include source code and other material shown to Codex. Reasoning records and structured binary content are excluded.

Selected excerpts are stored locally in private files under Codex’s plugin data directory. JevKeep reads the transcript without modifying it. Its diagnostics contain neither API keys nor conversation contents.

## Limits

- JevKeep preserves selected excerpts, not the entire conversation. Relevance scoring can miss something you need later.
- Preservation adds API requests and time to compaction. Scoring has a shared 20-second network deadline; the hook timeout is 30 seconds.
- Saved excerpts belong to one session and transcript. Invalid or stale state is discarded rather than restored into the wrong conversation.
- Codex’s transcript format can change. Unsupported formats skip preservation and leave native compaction running.

See [architecture and limits](docs/architecture.md) for the parser, byte budgets, and persistence rules.

## Development

```sh
npm ci --ignore-scripts
npm run build
```

The build checks TypeScript, bundles the runtime into `dist/jevkeep.cjs`, and generates third-party license notices. The bundle is committed so users can install without development dependencies.

After rebuilding, rerun the installer and its printed `codex plugin add` command. Review any changed hooks and start a new conversation.

Bug reports and contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Use synthetic examples in issues; leave out API keys and private conversations.

## Credits

**The original idea and Claude Code implementation are by [tamaratran](https://github.com/tamaratran) in [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).**

JevKeep includes unmodified library files from [commit `e3f262a`](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0) for request construction, response parsing, token estimates, and context budgeting. Codex transcript parsing, excerpt selection, hook integration, and local persistence are implemented here.

The upstream [MIT license](vendor/fast-jev-compaction/LICENSE) is preserved. See [UPSTREAM.md](vendor/fast-jev-compaction/UPSTREAM.md) for provenance and [THIRD_PARTY_LICENSES.txt](dist/THIRD_PARTY_LICENSES.txt) for bundled dependency notices.

## License

[MIT](LICENSE).
