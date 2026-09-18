#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { credential } from './config.js';
import { object, Skip, type Excerpt, type HookInput } from './model.js';
import { pack, renderPacket } from './packet.js';
import { score } from './scoring.js';
import { Store } from './state.js';
import { readTranscript } from './transcript.js';

function diagnostic(reason: string): void {
  process.stderr.write(`jevkeep: ${reason}; native compaction continues.\n`);
}

async function input(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65_536) throw new Skip('invalid hook input');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(value) || typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 512 ||
      typeof value.transcript_path !== 'string' || !isAbsolute(value.transcript_path) ||
      !['PreCompact', 'SessionStart'].includes(String(value.hook_event_name))) throw new Skip('invalid hook input');
  return value as unknown as HookInput;
}

function combine(carried: Excerpt[], current: Excerpt[]): Excerpt[] {
  const records = new Map(carried.map(record => [record.id, record]));
  for (const record of current) {
    const previous = records.get(record.id);
    if (previous?.role === 'tool' && record.role === 'tool') {
      const labels = new Set(record.parts.map(part => part.label));
      records.set(record.id, { ...record, order: Math.min(previous.order, record.order),
        source: previous.source, parts: [...previous.parts.filter(part => !labels.has(part.label)), ...record.parts] });
    } else records.set(record.id, record);
  }
  return [...records.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

async function run(signal: AbortSignal): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Skip('Node.js 22 or newer required');
  const event = await input();
  const pre = event.hook_event_name === 'PreCompact';
  if ((pre && process.argv[2] !== 'pre-compact') || (!pre && process.argv[2] !== 'session-start')) throw new Skip('hook event mismatch');
  const store = new Store(event.session_id, event.transcript_path);
  try {
    let saved = store.read();
    const pending = saved?.pending;
    const healthy = store.healthy();
    // Consume/invalidate first. A crash or any later error cannot replay a packet.
    store.begin(saved, !healthy);
    if (!healthy) throw new Skip('overlapping compaction skipped');
    if (!pre && !pending) return;
    if (pre && (!['manual', 'auto'].includes(event.trigger ?? '') || typeof event.turn_id !== 'string' || !event.turn_id)) {
      throw new Skip('invalid compaction event');
    }
    if (!pre && event.source !== 'compact') return;
    const snapshot = await readTranscript(event.transcript_path, event.session_id,
      [saved?.carry?.boundary.size, pending?.before.size].filter((size): size is number => size !== undefined));
    const lastBoundary = snapshot.boundaries.at(-1);
    if (saved && saved.identity !== snapshot.identity) {
      store.discard();
      throw new Skip('transcript identity changed');
    }
    saved ??= { version: 1, key: store.key, identity: snapshot.identity };

    if (pre) {
      let carry: Excerpt[] = [];
      if (saved.carry && lastBoundary?.id === saved.carry.boundary.id &&
          snapshot.checkpoints.get(saved.carry.boundary.size) === saved.carry.boundary.digest &&
          !snapshot.resets.some(offset => offset >= saved!.carry!.boundary.size)) carry = saved.carry.excerpts;
      else delete saved.carry;
      const records = combine(carry, snapshot.records);
      const latestUser = records.findLast(record => record.role === 'user');
      if (!latestUser) throw new Skip('no current user request');
      const apiKey = await credential();
      const scores = await score(records, latestUser, apiKey, signal);
      const selected = pack(records, scores, latestUser.id);
      signal.throwIfAborted();
      if (!store.healthy()) throw new Skip('overlapping compaction skipped');
      saved.pending = { created: Date.now(), turnId: event.turn_id!,
        before: { size: snapshot.size, digest: snapshot.digest }, boundary: lastBoundary?.id ?? null, excerpts: selected };
      store.write(saved);
      if (!store.healthy()) { delete saved.pending; store.write(saved); throw new Skip('overlapping compaction skipped'); }
      return;
    }

    if (!pending) return;
    const age = Date.now() - pending.created;
    const added = snapshot.boundaries.filter(boundary => boundary.start >= pending.before.size);
    const before = snapshot.boundaries.filter(boundary => boundary.start < pending.before.size).at(-1);
    const boundary = added[0];
    if (age < 0 || age > 30 * 60_000 || snapshot.checkpoints.get(pending.before.size) !== pending.before.digest ||
        (before?.id ?? null) !== pending.boundary || added.length !== 1 || !boundary || lastBoundary?.id !== boundary.id ||
        boundary.turnId !== pending.turnId || snapshot.hazards.some(offset => offset >= pending.before.size)) {
      throw new Skip('compaction boundary mismatch');
    }
    const packet = renderPacket(pending.excerpts);
    if (!store.healthy()) throw new Skip('overlapping compaction skipped');
    saved.carry = { boundary, excerpts: pending.excerpts };
    store.write(saved);
    signal.throwIfAborted();
    if (!store.healthy()) throw new Skip('overlapping compaction skipped');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: packet } }) + '\n');
  } finally { store.close(); }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const watchdog = setTimeout(() => {
    controller.abort();
    diagnostic('hook time limit');
    process.exit(0);
  }, 27_000);
  try { await run(controller.signal); }
  catch (error) { diagnostic(error instanceof Skip ? error.message : 'preservation unavailable'); }
  finally { clearTimeout(watchdog); }
}
void main();
