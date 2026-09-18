import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hash, MARKER, object, Skip, type Boundary, type Excerpt, type Part, type Snapshot } from './model.js';

type Json = Record<string, unknown>;
interface Item { payload: Json; order: number; turn: string; stamp?: string; event?: boolean }
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;

function plain(text: string): boolean {
  return !text.trimStart().startsWith(MARKER) && !text.includes(`\n${MARKER}\n`) && !text.includes('\u0000') &&
    !/data:(?:image|audio|video|application)\/[^\s]*;base64,/i.test(text);
}

/** Only textual blocks are accepted. No recursive serialization of unknown or
 * binary fields, encrypted reasoning, images, audio, or resource blobs. */
function textParts(value: unknown, label: string): Part[] {
  if (typeof value === 'string') {
    // MCP results sometimes arrive JSON-encoded inside output strings.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (object(parsed) && Array.isArray(parsed.content)) return textParts(parsed.content, label);
        if (Array.isArray(parsed) && parsed.some(item => object(item) && typeof item.type === 'string')) {
          return textParts(parsed, label);
        }
      } catch { /* ordinary text, not a structured result */ }
    }
    return value && plain(value) ? [{ label, text: value }] : [];
  }
  if (Array.isArray(value)) return value.flatMap(item => textParts(item, label));
  if (!object(value)) return [];
  if (['input_text', 'output_text', 'text'].includes(String(value.type))) {
    return typeof value.text === 'string' && plain(value.text) ? [{ label, text: value.text }] : [];
  }
  if (value.type === 'resource' && object(value.resource) && typeof value.resource.text === 'string') {
    return textParts(value.resource.text, label);
  }
  if (!value.type && (typeof value.content === 'string' || Array.isArray(value.content))) return textParts(value.content, label);
  return [];
}

function materialize(items: Item[]): Excerpt[] {
  const records: Excerpt[] = [];
  const calls = new Map<string, Excerpt>();
  const results = new Map<string, { parts: Part[]; source: string; order: number }>();
  const seen = new Set<string>();
  const canonicalText = new Set<string>();
  const messageKey = (_item: Item, role: string, parts: Part[]): string => hash(JSON.stringify([role, parts.map(p => p.text).join('\n')]));
  for (const item of items) {
    if (!item.event && item.payload.type === 'message') {
      canonicalText.add(messageKey(item, String(item.payload.role), textParts(item.payload.content, 'text')));
    }
  }
  for (const item of items) {
    const p = item.payload;
    const type = String(p.type);
    const unique = typeof p.id === 'string' ? `${type}:${p.id}` : hash(JSON.stringify([item.turn, item.stamp, p]));
    if (seen.has(unique)) continue;
    seen.add(unique);
    if (type === 'message' || item.event) {
      const role = item.event ? (type === 'user_message' ? 'user' : 'assistant') : p.role;
      if ((role !== 'user' && role !== 'assistant') || p.phase === 'analysis' || p.channel === 'analysis') continue;
      const parts = textParts(item.event ? p.message : p.content, 'text');
      if (!parts.length || (item.event && canonicalText.has(messageKey(item, role, parts)))) continue;
      records.push({ id: hash(unique), order: item.order, role, source: item.event ? 'event_msg' : 'message', parts });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      if (typeof p.call_id !== 'string' || typeof p.name !== 'string') throw new Skip('invalid tool record');
      const input = type === 'function_call' ? p.arguments : p.input;
      if (typeof input !== 'string') throw new Skip('invalid tool input');
      const parts = plain(input) ? [{ label: type === 'function_call' ? 'verbatim arguments' : 'verbatim input', text: input }] : [];
      const source = typeof p.namespace === 'string' ? `${p.namespace}.${p.name}` : p.name;
      const record: Excerpt = { id: hash(`call:${p.call_id}`), order: item.order, role: 'tool', source, callId: p.call_id, parts };
      if (calls.has(p.call_id)) continue;
      calls.set(p.call_id, record);
      records.push(record);
    } else if (['function_call_output', 'custom_tool_call_output', 'mcp_tool_call_output'].includes(type)) {
      if (typeof p.call_id !== 'string') continue;
      const parts = textParts(p.output, 'verbatim result');
      const previous = results.get(p.call_id);
      if (previous) {
        const known = new Set(previous.parts.map(part => hash(part.text)));
        previous.parts.push(...parts.filter(part => !known.has(hash(part.text))));
      } else {
        results.set(p.call_id, { parts, source: typeof p.name === 'string' ? p.name : type, order: item.order });
      }
    }
  }
  for (const [callId, result] of results) {
    const call = calls.get(callId);
    if (call) call.parts.push(...result.parts);
    else if (result.parts.length) records.push({ id: hash(`call:${callId}`), order: result.order,
      role: 'tool', source: result.source, callId, parts: result.parts });
  }
  return records.filter(record => record.parts.length > 0).sort((a, b) => a.order - b.order);
}

/** Read a fixed-size, read-only snapshot; reject torn JSONL or changed files. */
export async function readTranscript(path: string, sessionId: string, checkpoints: number[] = []): Promise<Snapshot> {
  const canonical = await realpath(path);
  const file = await open(canonical, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) throw new Skip('unsupported transcript size');
    const data = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < data.length) {
      const result = await file.read(data, read, Math.min(1024 * 1024, data.length - read), read);
      if (!result.bytesRead) throw new Skip('transcript changed during read');
      read += result.bytesRead;
    }
    if (data[data.length - 1] !== 10) throw new Skip('incomplete transcript');
    const digest = createHash('sha256');
    const savedCheckpoints = new Map<number, string>();
    const wanted = new Set(checkpoints);
    let items: Item[] = [];
    let retained: Excerpt[] = [];
    const boundaries: Boundary[] = [];
    const hazards: number[] = [];
    const resets: number[] = [];
    let turn = '';
    let sessionMeta = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const started = Date.now();
    for (let start = 0; start < data.length;) {
      if (Date.now() - started > 4_000) throw new Skip('transcript parsing time limit');
      const end = data.indexOf(10, start) + 1;
      if (end <= start || end - start > MAX_LINE_BYTES) throw new Skip('unsupported transcript record');
      const raw = data.subarray(start, end);
      digest.update(raw);
      if (wanted.has(end)) savedCheckpoints.set(end, digest.copy().digest('hex'));
      const line: unknown = JSON.parse(decoder.decode(raw));
      if (!object(line) || typeof line.type !== 'string' || !object(line.payload)) throw new Skip('malformed transcript');
      const p = line.payload;
      const stamp = typeof line.timestamp === 'string' ? line.timestamp : undefined;
      if (line.type === 'session_meta') {
        if (sessionMeta || p.id !== sessionId || (p.session_id !== undefined && p.session_id !== sessionId)) {
          throw new Skip('transcript session mismatch');
        }
        // Inherited/forked history is deliberately not followed through other files.
        if (p.history_base) throw new Skip('external transcript history is unsupported');
        sessionMeta = hash(raw);
      } else if (line.type === 'turn_context' && typeof p.turn_id === 'string') {
        turn = p.turn_id;
      } else if (line.type === 'response_item') {
        const metadata = object(line.metadata) ? line.metadata : {};
        items.push({ payload: p, order: start, turn: typeof metadata.turn_id === 'string' ? metadata.turn_id : turn, stamp });
      } else if (line.type === 'event_msg') {
        // Manual and pre-turn automatic compaction can use a fresh internal turn.
        // Its item_started event precedes the compacted checkpoint even when a
        // turn_context record has not yet been written for that turn.
        if (typeof p.turn_id === 'string') turn = p.turn_id;
        if (['user_message', 'agent_message'].includes(String(p.type))) items.push({ payload: p, order: start, turn, stamp, event: true });
        if (['thread_rolled_back', 'turn_aborted', 'error', 'user_message'].includes(String(p.type))) hazards.push(start);
        if (p.type === 'hook_completed' && object(p.run) &&
            ['PreCompact', 'pre_compact'].includes(String(p.run.event_name)) &&
            ['failed', 'blocked', 'stopped'].includes(String(p.run.status))) hazards.push(start);
        if (p.type === 'thread_rolled_back') { resets.push(start); items = []; retained = []; }
      } else if (line.type === 'compacted') {
        if (typeof p.message !== 'string') throw new Skip('malformed compaction boundary');
        const boundary: Boundary = { start, size: end, digest: digest.copy().digest('hex'), id: hash(raw), turnId: turn };
        boundaries.push(boundary);
        // Retain only exact records explicitly surviving native replacement history.
        // Never turn the generated native summary into a purported verbatim excerpt.
        const known = [...retained, ...materialize(items)];
        const signatures = new Map(known.map(record => [hash(JSON.stringify([record.role, record.source, record.callId, record.parts])), record]));
        const replacement = Array.isArray(p.replacement_history) ? p.replacement_history : [];
        const rebuilt = materialize(replacement.filter(object).map(payload => ({ payload, order: start, turn })));
        retained = rebuilt.flatMap(record => {
          const original = signatures.get(hash(JSON.stringify([record.role, record.source, record.callId, record.parts])));
          return original ? [original] : [];
        });
        items = [];
      }
      start = end;
    }
    if (!sessionMeta) throw new Skip('missing transcript identity');
    const after = await file.stat();
    if (after.size < stat.size || after.ino !== stat.ino) throw new Skip('transcript changed during read');
    const records = new Map([...retained, ...materialize(items)].map(record => [record.id, record]));
    return {
      size: data.length, digest: digest.digest('hex'),
      identity: hash(JSON.stringify([canonical, stat.dev, stat.ino, stat.birthtimeMs, sessionMeta])),
      boundaries, records: [...records.values()].sort((a, b) => a.order - b.order),
      checkpoints: savedCheckpoints, hazards, resets, turnId: turn,
    };
  } finally { await file.close(); }
}
