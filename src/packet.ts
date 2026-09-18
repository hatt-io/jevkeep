import { bytes, FOOTER, HEADER, MAX_PACKET_BYTES, type Excerpt, type Part, Skip } from './model.js';

// Buffer slicing must never bisect a UTF-8 code point.
export function head(text: string, limit: number): string {
  const buffer = Buffer.from(text);
  let end = Math.min(buffer.length, Math.max(0, limit));
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
function tail(text: string, limit: number): string {
  const buffer = Buffer.from(text);
  let start = Math.max(0, buffer.length - Math.max(0, limit));
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

export function headTail(text: string, limit: number): string {
  if (bytes(text) <= limit) return text;
  const marker = '\n[jevkeep: middle omitted; verbatim head above, tail below]\n';
  if (limit < bytes(marker) + 8) return '';
  const available = limit - bytes(marker);
  return head(text, Math.ceil(available / 2)) + marker + tail(text, Math.floor(available / 2));
}

function label(value: string): string {
  // Source labels are metadata, never interpreted as markup or instructions.
  return JSON.stringify(head(value, 200));
}
export function renderRecord(record: Excerpt): string {
  const call = record.callId ? ` call_id=${label(record.callId)}` : '';
  return `\n--- historical ${record.role}; source=${label(record.source)}${call}; position=${record.order} ---\n` +
    record.parts.map(part => `[${part.label}]\n${part.text}\n`).join('');
}
export function renderPacket(records: readonly Excerpt[]): string {
  const packet = HEADER + records.map(renderRecord).join('') + FOOTER;
  if (bytes(packet) > MAX_PACKET_BYTES) throw new Skip('packet exceeds byte limit');
  return packet;
}

function fitRecord(record: Excerpt, limit: number): Excerpt | undefined {
  if (bytes(renderRecord(record)) <= limit) return record;
  const empty = { ...record, parts: record.parts.map(part => ({ ...part, text: '' })) };
  let remaining = limit - bytes(renderRecord(empty));
  const parts: Part[] = [];
  // Short parts donate unused space to larger ones. Each paired call/result keeps
  // its own label and head/tail; truncating one combined string could lose the call.
  const slots = record.parts.map((part, index) => ({ part, index })).sort((a, b) => bytes(a.part.text) - bytes(b.part.text));
  for (let i = 0; i < slots.length; i++) {
    const { part, index } = slots[i]!;
    const budget = Math.floor(remaining / (slots.length - i));
    const text = headTail(part.text, budget);
    if (!text && part.text) return undefined;
    parts[index] = { ...part, text };
    remaining -= bytes(text);
  }
  const fitted = { ...record, parts };
  return bytes(renderRecord(fitted)) <= limit ? fitted : undefined;
}

export function pack(records: readonly Excerpt[], scores: ReadonlyMap<string, number>, latestUserId: string): Excerpt[] {
  let remaining = MAX_PACKET_BYTES - bytes(HEADER) - bytes(FOOTER);
  const ranked = records.filter(record => record.id === latestUserId || (scores.get(record.id) ?? 0) >= 0.5)
    .sort((a, b) => Number(b.id === latestUserId) - Number(a.id === latestUserId) ||
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || b.order - a.order || a.id.localeCompare(b.id));
  const selected: Excerpt[] = [];
  for (const record of ranked) {
    const fitted = fitRecord(record, remaining);
    if (!fitted) continue;
    selected.push(fitted);
    remaining -= bytes(renderRecord(fitted));
  }
  selected.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  renderPacket(selected);
  return selected;
}
