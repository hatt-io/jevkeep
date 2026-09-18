import { chmodSync, closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { lockSync } from 'proper-lockfile';
import { hash, object, Skip, type Boundary, type Checkpoint, type Excerpt, type State } from './model.js';
import { renderPacket } from './packet.js';

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && stat.uid !== process.getuid?.())) throw new Skip('invalid state directory');
  chmodSync(path, 0o700);
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const position = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function checkpoint(value: unknown): value is Checkpoint {
  return object(value) && position(value.size) && digest(value.digest);
}
function boundary(value: unknown): value is Boundary {
  return object(value) && checkpoint(value) && position(value.start) && value.start < value.size && digest(value.id) && typeof value.turnId === 'string';
}
function excerpts(value: unknown): value is Excerpt[] {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const ids = new Set<string>();
  for (const record of value) {
    if (!object(record) || !digest(record.id) || ids.has(record.id) || !position(record.order) ||
        !['user', 'assistant', 'tool'].includes(String(record.role)) || typeof record.source !== 'string' || record.source.length > 1024 ||
        (record.callId !== undefined && (typeof record.callId !== 'string' || record.callId.length > 1024)) ||
        !Array.isArray(record.parts) || !record.parts.length || record.parts.length > 1000 ||
        !record.parts.every(part => object(part) && ['text', 'verbatim arguments', 'verbatim input', 'verbatim result'].includes(String(part.label)) && typeof part.text === 'string')) return false;
    ids.add(record.id);
  }
  renderPacket(value as Excerpt[]);
  return true;
}
function valid(value: unknown, key: string): value is State {
  if (!object(value) || value.version !== 1 || value.key !== key || !digest(value.identity)) return false;
  if (value.carry !== undefined && (!object(value.carry) || !boundary(value.carry.boundary) || !excerpts(value.carry.excerpts))) return false;
  if (value.pending !== undefined) {
    const p = value.pending;
    if (!object(p) || !position(p.created) || typeof p.turnId !== 'string' || !p.turnId ||
        !checkpoint(p.before) || !(p.boundary === null || digest(p.boundary)) || !excerpts(p.excerpts)) return false;
  }
  return true;
}

/** Atomic state under an exclusive, heartbeating mkdir lock. Contention poisons
 * the in-flight packet, so neither competing compaction can consume it. */
export class Store {
  readonly key: string;
  private readonly dir: string;
  private readonly path: string;
  private readonly poison: string;
  private compromised = false;
  private release?: () => void;

  constructor(session: string, transcript: string) {
    const root = process.env.PLUGIN_DATA;
    if (!root || !isAbsolute(root)) throw new Skip('PLUGIN_DATA unavailable');
    privateDirectory(root);
    const sessions = join(root, 'sessions');
    privateDirectory(sessions);
    this.key = hash(JSON.stringify([session, resolve(transcript)]));
    this.dir = join(sessions, this.key);
    privateDirectory(this.dir);
    this.path = join(this.dir, 'state.json');
    this.poison = join(this.dir, 'invalidated');
    try {
      this.release = lockSync(this.path, {
        realpath: false, stale: 35_000, update: 5000, retries: 0,
        onCompromised: () => { this.compromised = true; this.invalidate(); },
      });
    } catch {
      this.invalidate();
      throw new Skip('overlapping compaction skipped');
    }
  }

  invalidate(): void {
    try {
      const fd = openSync(this.poison, 'wx', 0o600);
      fsyncSync(fd);
      closeSync(fd);
    } catch { /* an existing marker already invalidates the packet */ }
  }
  healthy(): boolean { return !this.compromised && !existsSync(this.poison); }

  read(): State | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 512_000 ||
          (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Skip('invalid saved state');
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!valid(value, this.key)) throw new Skip('invalid saved state');
      return value;
    } catch (error) {
      if (object(error) && error.code === 'ENOENT') return undefined;
      this.discard();
      throw new Skip('invalid saved state');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  write(state: State): void {
    if (this.compromised || !valid(state, this.key)) throw new Skip('state write unavailable');
    // Durable transaction staging stays alongside state, never in an OS temp dir.
    const next = join(this.dir, 'state.next');
    const fd = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(next, this.path);
    if (process.platform !== 'win32') {
      const directory = openSync(this.dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }

  discard(): void {
    try { unlinkSync(this.path); } catch (error) {
      if (!object(error) || error.code !== 'ENOENT') { this.invalidate(); throw new Skip('state invalidation unavailable'); }
    }
  }

  begin(state: State | undefined, clearInvalidation: boolean): void {
    // Remove the old pending packet before any parsing, credentials, or network.
    if (state) {
      this.discard();
      delete state.pending;
      this.write(state);
    }
    // Only a skipped invocation can clear a pre-existing poison marker. Never
    // erase a contention marker created during the current successful attempt.
    if (clearInvalidation && existsSync(this.poison)) unlinkSync(this.poison);
  }

  close(): void {
    try { this.release?.(); } catch { this.invalidate(); }
    this.release = undefined;
  }
}
