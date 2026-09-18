# Architecture

JevKeep runs before and after Codex compaction. This document describes the limits and persistence rules behind those hooks.

- Synchronous `PreCompact` handles `manual` and `auto`. The transcript is read-only.
- Scores text and paired tool records alongside excerpts kept in the previous
  round. The latest user request takes priority, then score ≥ `0.5`, then recency.
  Selected records return in chronological order, with role and tool labels.
- Each restored packet is at most **24,000 UTF-8 bytes**, including labels.
  Oversized parts use marked verbatim head/tail excerpts. `additionalContextLimit: 0`
  avoids Codex spilling that bounded context into temporary files.
- Upstream budgeting allows an estimated 25,000 state tokens and 30,000 request
  tokens. At most two requests run at once, sharing a 20-second network deadline.
  Hook timeout: 30 seconds; internal watchdog: 27 seconds.
- State is isolated by session and transcript path, checked against file identity,
  an exact transcript-prefix digest, and the next compaction boundary. Packets are
  consumed before output and expire after 30 minutes. Overlapping attempts invalidate
  their packet; crashed locks become reclaimable after 35 seconds.
- Missing credentials, failed scoring, malformed transcripts, changed history, or
  invalid state skip preservation and let native compaction continue. A crash between
  consumption and output may lose a packet; it cannot replay that packet.

The parser supports Codex JSONL `session_meta`, `response_item`, `event_msg`,
`turn_context`, and `compacted` records, including function/custom calls and their
textual results. It deduplicates event mirrors and ignores injected hook context.
Native replacement history only retains excerpts found verbatim in earlier records.
External inherited-history files are not followed. Snapshots above 256 MiB, records
above 32 MiB, incomplete JSONL, and unsupported transcript layouts skip preservation.
Codex documents the transcript format as unstable; future changes may require an update.


## Source layout

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Hook lifecycle and fallback behavior |
| `src/transcript.ts` | Read-only Codex transcript parsing |
| `src/scoring.ts` | Relevance questions, request budgets, and scheduling |
| `src/packet.ts` | Excerpt selection and bounded context output |
| `src/state.ts` | Session isolation, locking, and one-time restoration |
| `src/config.ts` | Environment and private-file credentials |
| `vendor/fast-jev-compaction/` | Upstream request, parsing, and budgeting code |

See [upstream provenance](../vendor/fast-jev-compaction/UPSTREAM.md) for the pinned source revision and reused files.
