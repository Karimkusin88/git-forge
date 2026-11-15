/**
 * forge — a GitHub-compatible git forge in a single Node process.
 *
 * One process serves four surfaces from one in-memory store:
 *   - git smart HTTP (protocol v2 ls-refs/fetch, v0 fetch fallback, v0 receive-pack push)
 *     at /<owner>/<repo>.git/...
 *   - the REST v3 API at /api/v3/...
 *   - the GraphQL v4 API at /api/graphql
 *   - the Model Context Protocol (streamable HTTP, JSON answers) at /mcp
 *
 * Standard library only. No wall clock in any response: timestamps come from a logical
 * clock seeded by MAKEFUN_TRIAL_NOW (or a fixed epoch), so identical request sequences
 * produce identical bytes.
 *
 * Lifecycle (the make.fun envelope): listen on an ephemeral port, POST {"port": N} to
 * $MAKEFUN_ENV_URL/register, poll GET $MAKEFUN_ENV_URL/done, exit 0 when it answers done.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// configuration and the logical clock
// ---------------------------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The trial's opening time when the env provides one; a fixed epoch otherwise. */
function trialEpochSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
  }
  return 1767225600; // 2026-01-01T00:00:00Z
}

let clockSeconds = trialEpochSeconds();

/** The current logical second; every call advances the clock by one second. */
function tickSeconds(): number {
  const value = clockSeconds;
  clockSeconds += 1;
  return value;
}

/** An ISO-8601 timestamp from the logical clock (advances it). */
function isoNow(): string {
  return isoOf(tickSeconds());
}

function isoOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

function isOid(value: unknown): value is string {
  return typeof value === 'string' && HEX40.test(value);
}

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

type GitObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObj {
  type: GitObjType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` + bytes. */
function hashObject(type: GitObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, directories compared as if trailing '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

interface TagView {
  object: string;
  type: string;
  tag: string;
}

function parseTag(data: Buffer): TagView {
  const view: TagView = { object: '', type: '', tag: '' };
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    if (key === 'object') view.object = line.slice(space + 1);
    else if (key === 'type') view.type = line.slice(space + 1);
    else if (key === 'tag') view.tag = line.slice(space + 1);
  }
  return view;
}

// ---------------------------------------------------------------------------
// packfiles: write (plain objects) and read (with OFS/REF delta resolution)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of whole objects (never thin, never deltified), trailer-checked. */
function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a packfile and resolve every object. `resolveExternal` supplies bases for a thin
 * pack's REF deltas (objects the receiving store already holds). Throws on any corruption:
 * a bad trailer, a bad size, a missing base.
 */
function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = sha1hex(pack.subarray(0, trailerStart));
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta base offset is invalid');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, GitObj>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObj => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let resolved: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const base = resolvedByOid.get(entry.baseOid ?? '') ?? resolveExternal?.(entry.baseOid ?? '');
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is unavailable`);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    resolving.delete(entry.offset);
    resolvedByOid.set(hashObject(resolved.type, resolved.data), resolved);
    return resolved;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    objects.set(hashObject(object.type, object.data), object);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

const PKT_MAX_PAYLOAD = 65520 - 4;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/**
 * Decode pkt-lines from the front of `buffer`. Returns the packets and the number of
 * bytes consumed; stops (without consuming) at the first byte that cannot be a packet —
 * receive-pack's raw packfile begins there.
 */
function decodePkts(buffer: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 4) break;
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) break;
    if (buffer.length - offset < length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Chunk a byte stream into sideband band-1 pkt-lines (plus an optional band-2 note). */
function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  if (data.length === 0) return Buffer.alloc(0);
  while (offset < data.length) {
    const take = Math.min(PKT_MAX_PAYLOAD - 1, data.length - offset);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + take)])));
    offset += take;
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// the store: users, repositories, issues, pull requests
// ---------------------------------------------------------------------------

interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
}

const VIEWER: UserRec = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

const USERS: Record<string, UserRec> = {
  adaiversen: VIEWER,
  quinnkeller: { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  olgabauer: { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  dmitriquist: { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  adanovak: { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  zanerossi: { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  pavelcosta: { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  wrenkeller: { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  coraquist: { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  elenaulrich: { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  tesssato: { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  svenrossi: { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
};

const ORG_LOGIN = 'faint-meadow-org';

interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  createdAt: string;
}

interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
}

interface LabelRec {
  name: string;
  color: string;
}

interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
  createdAt: string;
}

const reposByKey = new Map<string, RepoRec>();
const reposById = new Map<number, RepoRec>();
let nextRepoId = 5001;
let nextIssueId = 9001;
let nextCommentId = 7001;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function getRepo(owner: string, name: string): RepoRec | undefined {
  return reposByKey.get(repoKey(owner, name));
}

function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId++,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    createdAt: isoNow(),
  };
  reposByKey.set(repoKey(owner, name), repo);
  reposById.set(repo.id, repo);
  return repo;
}

/** The viewer's identity line for commits this forge authors itself. */
function identLine(epochSeconds: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSeconds} +0000`;
}

// ---------------------------------------------------------------------------
// tree and history helpers over a repo's object store
// ---------------------------------------------------------------------------

function storeObject(repo: RepoRec, type: GitObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function commitTreeOid(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
function flatTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flatTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path map; answers the root tree id. */
function treeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Every object reachable from `roots` (commits, trees, blobs, tags). Missing roots are
 * ignored. Commits in `stopAt` (a client's declared shallow boundary) contribute their
 * tree but their parents are not traversed: a shallow client does not hold them.
 */
function collectReachable(repo: RepoRec, roots: Iterable<string>, stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopAt?.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** All ancestors of a commit (including itself), nearest first. */
function ancestorsOf(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** The best common ancestor of two commits, or null when they share no history. */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestors = new Set(ancestorsOf(repo, a));
  for (const candidate of ancestorsOf(repo, b)) {
    if (ancestors.has(candidate)) return candidate;
  }
  return null;
}

/** Follow tag objects to the commit they ultimately name (or the object itself). */
function peelToCommit(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Commits reachable from a tip, newest first (DFS pre-order over parents). */
function walkCommits(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]);
  }
  return order;
}

/**
 * Commit a set of file changes onto a branch: `changes` maps a path to a blob id, or
 * null to delete it. Creates the branch (unborn) when it does not exist yet.
 */
function commitChanges(
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, string | null>,
  message: string,
): { commitOid: string; treeOid: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip ? commitTreeOid(repo, tip) : null;
  const flat = baseTree ? flatTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  for (const [path, blobOid] of changes) {
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = treeFromFlat(repo, flat);
  const ts = tickSeconds();
  const ident = identLine(ts);
  const commitOid = storeObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: tip ? [tip] : [], message, author: ident, committer: ident }),
  );
  repo.refs.set(ref, commitOid);
  return { commitOid, treeOid };
}

// ---------------------------------------------------------------------------
// three-way tree merge and pull-request merging (shared by REST, GraphQL, MCP)
// ---------------------------------------------------------------------------

interface MergeOutcome {
  ok: boolean;
  sha: string | null;
  status: number;
  message: string;
}

/** Three-way merge of flat trees; returns the merged flat map or the conflicting path. */
function mergeFlats(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): { flat: Map<string, { oid: string; mode: string }> } | { conflict: string } {
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid;
    if (same(o, t)) {
      if (o) merged.set(path, o);
    } else if (same(b, o)) {
      if (t) merged.set(path, t);
    } else if (same(b, t)) {
      if (o) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { flat: merged };
}

function flatOfCommit(repo: RepoRec, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  if (!commitOid) return new Map();
  const tree = commitTreeOid(repo, commitOid);
  return tree ? flatTree(repo, tree) : new Map();
}

/** Whether head can merge into base cleanly right now (and the merge-base used). */
function mergeability(repo: RepoRec, baseTip: string, headTip: string): { mergeable: boolean; base: string | null } {
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return { mergeable: false, base: null };
  if (mb === headTip) return { mergeable: false, base: mb }; // nothing to merge
  const result = mergeFlats(flatOfCommit(repo, mb), flatOfCommit(repo, baseTip), flatOfCommit(repo, headTip));
  return { mergeable: 'flat' in result, base: mb };
}

/** Perform a pull request's merge (squash by default). Shared by all three surfaces. */
function performMerge(repo: RepoRec, pull: PullRec, method: string): MergeOutcome {
  if (pull.merged) return { ok: false, sha: null, status: 405, message: 'Pull Request is already merged' };
  if (pull.state === 'closed') return { ok: false, sha: null, status: 405, message: 'Pull Request is closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { ok: false, sha: null, status: 405, message: 'A branch tip is missing' };
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return { ok: false, sha: null, status: 405, message: 'The branches share no history' };
  if (mb === headTip) return { ok: false, sha: null, status: 405, message: 'There is nothing to merge' };
  const merged = mergeFlats(flatOfCommit(repo, mb), flatOfCommit(repo, baseTip), flatOfCommit(repo, headTip));
  if ('conflict' in merged) {
    return { ok: false, sha: null, status: 405, message: `Merge conflict in ${merged.conflict}` };
  }
  const treeOid = treeFromFlat(repo, merged.flat);
  const ts = tickSeconds();
  const ident = identLine(ts);
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    parents = [baseTip, headTip];
  } else {
    message = pull.body ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `${pull.title} (#${pull.number})`;
    parents = [baseTip];
  }
  const commitOid = storeObject(repo, 'commit', buildCommit({ tree: treeOid, parents, message, author: ident, committer: ident }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(ts);
  pull.mergeCommitSha = commitOid;
  return { ok: true, sha: commitOid, status: 200, message: 'Pull Request successfully merged' };
}

// ---------------------------------------------------------------------------
// line diffs for the pull-request files view
// ---------------------------------------------------------------------------

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Additions/deletions between two blob versions, by an LCS over lines. */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 4000 || newLines.length > 4000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two commits' trees (base tip vs head tip). */
function diffCommits(repo: RepoRec, baseTip: string, headTip: string): FileChange[] {
  const baseFlat = flatOfCommit(repo, baseTip);
  const headFlat = flatOfCommit(repo, headTip);
  const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort();
  const changes: FileChange[] = [];
  for (const path of paths) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before && !after) {
      const deletions = countLines(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0));
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!before && after) {
      const additions = countLines(repo.objects.get(after.oid)?.data ?? Buffer.alloc(0));
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before && after && before.oid !== after.oid) {
      const { additions, deletions } = lineDiff(
        repo.objects.get(before.oid)?.data ?? Buffer.alloc(0),
        repo.objects.get(after.oid)?.data ?? Buffer.alloc(0),
      );
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// JSON views of the store
// ---------------------------------------------------------------------------

function userJson(user: UserRec): Record<string, unknown> {
  return { login: user.login, id: user.id, type: 'User', name: user.name, email: user.email };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(USERS[repo.owner] ?? { id: 2000, login: repo.owner, name: repo.owner, email: '' }),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function issueJson(issue: IssueRec, repo: RepoRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: userJson(VIEWER),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    closed_at: issue.state === 'closed' ? issue.createdAt : null,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson(VIEWER) };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: userJson(VIEWER) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: userJson(VIEWER) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(VIEWER),
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

/** Parse a git ident line ("Name <email> 1700000000 +0000") for the commits view. */
function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) /.exec(line);
  if (!match) return { name: line, email: '', date: isoOf(trialEpochSeconds()) };
  return { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object && object.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: identJson(commit.author),
      committer: identJson(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function readBody(req: IncomingMessage, cap = 512 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** The one credential check every surface shares (open only when no token is configured). */
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${SHOP_TOKEN}`;
}

function messageError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Parse a JSON request body; {} for an empty one, null (after answering 400) for bad JSON. */
async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    messageError(res, 400, 'Problems parsing JSON');
    return null;
  }
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

const OAUTH_SCOPES = 'repo, read:org';

interface RestContext {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  origin: string;
  pathname: string;
}

/** Apply per_page/page slicing and the Link header the pagination checks follow. */
function paginate<T>(ctx: RestContext, items: readonly T[]): T[] {
  const perPage = clampInt(Number(ctx.query.get('per_page') ?? 30) || 30, 1, 100);
  const page = clampInt(Number(ctx.query.get('page') ?? 1) || 1, 1, 1000000);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const next = `${ctx.origin}${ctx.pathname}?per_page=${perPage}&page=${page + 1}`;
    const last = `${ctx.origin}${ctx.pathname}?per_page=${perPage}&page=${lastPage}`;
    ctx.res.setHeader('link', `<${next}>; rel="next", <${last}>; rel="last"`);
  }
  return slice;
}

async function handleRest(ctx: RestContext, segments: string[]): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  res.setHeader('x-oauth-scopes', OAUTH_SCOPES);
  const rest = segments.slice(2); // after api/v3

  // ----- root, meta, user -----
  if (rest.length === 0) {
    if (method !== 'GET') return messageError(res, 404, 'Not Found');
    return sendJson(res, 200, {
      current_user_url: `${ctx.origin}/api/v3/user`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      issue_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}/issues`,
    });
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return messageError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: '1.0.0', github_developer_version: 'forge' });
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return messageError(res, 404, 'Not Found');
    return sendJson(res, 200, userJson(VIEWER));
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const mine = [...reposByKey.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
      return sendJson(res, 200, paginate(ctx, mine).map(repoJson));
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const name = str(body.name);
      if (name === '') return messageError(res, 422, 'Validation Failed: name is required');
      if (getRepo(VIEWER.login, name)) {
        return messageError(res, 422, `Validation Failed: name already exists on this account`);
      }
      const repo = createRepo(VIEWER.login, name, str(body.description), body.private === true);
      return sendJson(res, 201, repoJson(repo));
    }
    return messageError(res, 404, 'Not Found');
  }

  // ----- /repos/{owner}/{repo}/... -----
  if (rest[0] !== 'repos' || rest.length < 3) return messageError(res, 404, 'Not Found');
  const repo = getRepo(rest[1], rest[2]);
  if (!repo) return messageError(res, 404, 'Not Found');
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        reposByKey.delete(repoKey(repo.owner, repo.name));
        repo.name = body.name;
        reposByKey.set(repoKey(repo.owner, repo.name), repo);
      }
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      reposByKey.delete(repoKey(repo.owner, repo.name));
      reposById.delete(repo.id);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      return res.end();
    }
    return messageError(res, 404, 'Not Found');
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, branches);
    }
    if (tail.length >= 2 && method === 'GET') {
      const name = tail.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${name}`);
      if (!oid) return messageError(res, 404, 'Not Found');
      return sendJson(res, 200, { name, commit: { sha: oid } });
    }
    return messageError(res, 404, 'Not Found');
  }

  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) && repo.objects.has(shaParam) ? shaParam : undefined);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (!tip) return sendJson(res, 200, []);
    const commits = walkCommits(repo, tip).map((oid) => commitJson(repo, oid));
    return sendJson(res, 200, paginate(ctx, commits));
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        return messageError(res, 422, 'Validation Failed: ref and a known object sha are required');
      }
      if (repo.refs.has(ref)) return messageError(res, 422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) return messageError(res, 404, 'Not Found');
      return sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
    }
    return messageError(res, 404, 'Not Found');
  }

  if (tail[0] === 'contents') {
    return handleContents(ctx, repo, tail.slice(1).join('/'));
  }

  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const name = str(body.name);
      if (name === '') return messageError(res, 422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return messageError(res, 422, 'Validation Failed: label already exists');
      const label: LabelRec = { name, color: str(body.color) || 'ededed' };
      repo.labels.set(name, label);
      return sendJson(res, 201, { name: label.name, color: label.color });
    }
    return messageError(res, 404, 'Not Found');
  }

  if (tail[0] === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1));
  }

  if (tail[0] === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1));
  }

  return messageError(res, 404, 'Not Found');
}

// ----- contents -----

/** Walk a tree to a path: a file entry, a directory's tree id, or null. */
function lookupPath(repo: RepoRec, treeOid: string, path: string): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
  if (path === '') return { kind: 'dir', oid: treeOid };
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function resolveRefCommit(repo: RepoRec, refParam: string | null): string | undefined {
  if (refParam) {
    const byBranch = repo.refs.get(`refs/heads/${refParam}`);
    if (byBranch) return byBranch;
    if (isOid(refParam) && repo.objects.has(refParam)) return peelToCommit(repo, refParam);
    return undefined;
  }
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

async function handleContents(ctx: RestContext, repo: RepoRec, path: string): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const commit = resolveRefCommit(repo, ctx.query.get('ref'));
    if (!commit) return messageError(res, 404, 'Not Found');
    const tree = commitTreeOid(repo, commit);
    if (!tree) return messageError(res, 404, 'Not Found');
    const found = lookupPath(repo, tree, path);
    if (!found) return messageError(res, 404, 'Not Found');
    if (found.kind === 'file') {
      const blob = repo.objects.get(found.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: found.oid,
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    const dirObject = repo.objects.get(found.oid);
    if (!dirObject || dirObject.type !== 'tree') return messageError(res, 404, 'Not Found');
    const entries = parseTree(dirObject.data).map((entry) => {
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const isDir = entry.mode === '40000';
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      };
    });
    return sendJson(res, 200, entries);
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = await jsonBody(req, res);
    if (body === null) return;
    if (path === '') return messageError(res, 422, 'Validation Failed: a file path is required');
    const branch = str(body.branch) || repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    // A contents write to a branch that does not exist yet starts it from the default
    // branch's tip (or unborn, on an empty repository): the branch-creation fallback.
    if (!repo.refs.has(ref)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(ref, defaultTip);
    }
    const tip = repo.refs.get(ref);
    const tree = tip ? commitTreeOid(repo, tip) : null;
    const existing = tree ? lookupPath(repo, tree, path) : null;

    if (method === 'DELETE') {
      if (!existing || existing.kind !== 'file') return messageError(res, 404, 'Not Found');
      if (str(body.sha) !== existing.oid) return messageError(res, 409, 'Conflict: the sha does not match the file');
      const message = str(body.message) || `Delete ${path}`;
      const { commitOid } = commitChanges(repo, branch, new Map([[path, null]]), message);
      return sendJson(res, 200, { content: null, commit: { sha: commitOid } });
    }

    // PUT
    const contentBase64 = str(body.content).replace(/\s+/g, '');
    if (typeof body.content !== 'string') return messageError(res, 422, 'Validation Failed: content is required');
    const data = Buffer.from(contentBase64, 'base64');
    const blobOid = storeObject(repo, 'blob', data);
    const existed = existing !== null && existing.kind === 'file';
    if (existed) {
      const givenSha = str(body.sha);
      if (givenSha === '') return messageError(res, 422, 'Validation Failed: sha is required to update a file');
      if (givenSha !== (existing as { oid: string }).oid) {
        return messageError(res, 409, 'Conflict: the sha does not match the file');
      }
    }
    const message = str(body.message) || (existed ? `Update ${path}` : `Create ${path}`);
    const { commitOid } = commitChanges(repo, branch, new Map([[path, blobOid]]), message);
    return sendJson(res, existed ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid },
    });
  }

  return messageError(res, 404, 'Not Found');
}

// ----- issues -----

async function handleIssues(ctx: RestContext, repo: RepoRec, tail: string[]): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = str(ctx.query.get('state')) || 'open';
      const direction = str(ctx.query.get('direction')) || 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendJson(res, 200, paginate(ctx, issues).map((issue) => issueJson(issue, repo)));
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const title = str(body.title);
      if (title === '') return messageError(res, 422, 'Validation Failed: title is required');
      const labels = issueLabelNames(repo, body.labels);
      if (labels === null) return messageError(res, 422, 'Validation Failed: one or more labels do not exist');
      const issue = createIssue(repo, title, str(body.body), labels);
      return sendJson(res, 201, issueJson(issue, repo));
    }
    return messageError(res, 404, 'Not Found');
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (tail.length === 1) {
    if (!issue) return messageError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, issueJson(issue, repo));
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (body.labels !== undefined) {
        const labels = issueLabelNames(repo, body.labels);
        if (labels === null) return messageError(res, 422, 'Validation Failed: one or more labels do not exist');
        issue.labels = labels;
      }
      return sendJson(res, 200, issueJson(issue, repo));
    }
    return messageError(res, 404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return messageError(res, 404, 'Not Found');
    if (method === 'GET') {
      return sendJson(res, 200, issue.comments.map(commentJson));
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const text = str(body.body);
      if (text === '') return messageError(res, 422, 'Validation Failed: body is required');
      const comment: CommentRec = { id: nextCommentId++, body: text, seq: globalSeq++ };
      issue.comments.push(comment);
      return sendJson(res, 201, commentJson(comment));
    }
    return messageError(res, 404, 'Not Found');
  }

  return messageError(res, 404, 'Not Found');
}

/** Label names from a create/update payload, or null when one names no label of the repo. */
function issueLabelNames(repo: RepoRec, raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : '';
    if (name === '' || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: globalSeq++,
    createdAt: isoNow(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

// ----- pull requests -----

async function handlePulls(ctx: RestContext, repo: RepoRec, tail: string[]): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = str(ctx.query.get('state')) || 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      return sendJson(res, 200, paginate(ctx, pulls).map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const outcome = createPull(repo, {
        title: str(body.title),
        body: str(body.body),
        head: str(body.head),
        base: str(body.base),
      });
      if (!outcome.ok) return messageError(res, outcome.status, outcome.message);
      return sendJson(res, 201, pullJson(repo, outcome.pull));
    }
    return messageError(res, 404, 'Not Found');
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (tail.length === 1 && method === 'GET') {
    if (!pull) return messageError(res, 404, 'Not Found');
    return sendJson(res, 200, pullJson(repo, pull));
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pull) return messageError(res, 404, 'Not Found');
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    // The diff is taken against the base tip the pull was opened from, so a later
    // merge of another pull cannot rewrite this pull's file list.
    const changes = diffCommits(repo, pull.baseSha, headTip);
    return sendJson(res, 200, changes);
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) return messageError(res, 404, 'Not Found');
    const body = await jsonBody(req, res);
    if (body === null) return;
    const methodWanted = str(body.merge_method) || 'squash';
    const outcome = performMerge(repo, pull, methodWanted === 'merge' ? 'merge' : 'squash');
    if (!outcome.ok) return messageError(res, outcome.status, outcome.message);
    return sendJson(res, 200, { sha: outcome.sha, merged: true, message: outcome.message });
  }

  return messageError(res, 404, 'Not Found');
}

interface CreatePullOutcome {
  ok: boolean;
  status: number;
  message: string;
  pull: PullRec;
}

/** Open a pull request (shared validation for REST, GraphQL and MCP). */
function createPull(repo: RepoRec, fields: { title: string; body: string; head: string; base: string }): CreatePullOutcome {
  const fail = (status: number, message: string): CreatePullOutcome => ({ ok: false, status, message, pull: undefined as unknown as PullRec });
  const stripOwner = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
  const head = stripOwner(fields.head);
  const base = stripOwner(fields.base);
  if (fields.title === '') return fail(422, 'Validation Failed: title is required');
  if (head === '' || base === '') return fail(422, 'Validation Failed: head and base are required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip) return fail(422, `Validation Failed: head branch ${head} does not exist`);
  if (!baseTip) return fail(422, `Validation Failed: base branch ${base} does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return { ok: true, status: 200, message: 'already exists', pull: existing };
    }
  }
  const pull: PullRec = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title: fields.title,
    body: fields.body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: globalSeq++,
    createdAt: isoNow(),
  };
  repo.pulls.set(pull.number, pull);
  return { ok: true, status: 201, message: 'created', pull };
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

type GitService = 'git-upload-pack' | 'git-receive-pack';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function handleInfoRefs(res: ServerResponse, repo: RepoRec, service: GitService, wantsV2: boolean): void {
  if (service === 'git-upload-pack' && wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
  }
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=forge/1.0`
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      lines.push(pktLine(`${oid} ${ref}\n`));
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') lines.push(pktLine(`${peelToCommit(repo, oid)} ${ref}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return sendRaw(res, 200, Buffer.concat(lines), `application/x-${service}-advertisement`);
}

function handleLsRefs(res: ServerResponse, repo: RepoRec, argLines: readonly string[]): void {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip) out.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    else out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const object = repo.objects.get(oid);
    if (peel && object?.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
  missingWant: string | null;
  commonHave: string | null;
}

/** Decide exactly which objects a fetch sends, honouring haves and shallow depth. */
function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  shallowArgs: readonly string[],
  depth: number | null,
): FetchPlan {
  for (const want of wants) {
    if (!repo.objects.has(want)) return { objects: [], shallow: [], unshallow: [], missingWant: want, commonHave: null };
  }
  const existingHaves = haves.filter((have) => repo.objects.has(have));
  const haveClosure = collectReachable(repo, existingHaves, new Set(shallowArgs));
  const commonHave = existingHaves.length ? existingHaves[existingHaves.length - 1] : null;

  if (depth === null) {
    const send = collectReachable(repo, wants);
    for (const oid of haveClosure) send.delete(oid);
    return {
      objects: [...send].map((oid) => repo.objects.get(oid)!).filter(Boolean),
      shallow: [],
      unshallow: [],
      missingWant: null,
      commonHave,
    };
  }

  // Depth-limited: commits at levels 0..depth-1 from the wants, with their full trees.
  const levelOf = new Map<string, number>();
  const included = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    let current = want;
    // Tags ride along at the same level as the commit they name.
    for (let guard = 0; guard < 32; guard += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') break;
      included.add(current);
      current = parseTag(object.data).object;
    }
    if (repo.objects.get(current)?.type === 'commit') queue.push({ oid: current, level: 0 });
    else if (repo.objects.has(current)) included.add(current);
  }
  while (queue.length) {
    const { oid, level } = queue.shift()!;
    if (levelOf.has(oid) && levelOf.get(oid)! <= level) continue;
    levelOf.set(oid, level);
    included.add(oid);
    if (level + 1 >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: level + 1 });
  }
  const boundary = new Set<string>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    // The commit's tree (and everything under it) always travels with it.
    for (const reachable of collectReachable(repo, [commit.tree])) included.add(reachable);
    for (const parent of commit.parents) {
      if (!included.has(parent) && repo.objects.has(parent)) boundary.add(oid);
    }
  }
  const unshallow = shallowArgs.filter((oid) => included.has(oid) && !boundary.has(oid));
  for (const oid of haveClosure) included.delete(oid);
  return {
    objects: [...included].map((oid) => repo.objects.get(oid)!).filter(Boolean),
    shallow: [...boundary].sort(),
    unshallow,
    missingWant: null,
    commonHave,
  };
}

function handleFetch(res: ServerResponse, repo: RepoRec, argLines: readonly string[], v2: boolean): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  let sawDone = false;
  for (const line of argLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowArgs.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line === 'done') sawDone = true;
    // thin-pack, no-progress, ofs-delta, deepen-since, deepen-not, filter: accepted.
  }
  if (wants.length === 0) {
    return sendRaw(res, 400, Buffer.from('no wants\n'), 'text/plain; charset=utf-8');
  }
  const plan = planFetch(repo, wants, haves, shallowArgs, depth !== null && Number.isFinite(depth) ? depth : null);
  if (plan.missingWant) {
    return sendRaw(res, 400, Buffer.from(`object not found: ${plan.missingWant}\n`), 'text/plain; charset=utf-8');
  }
  const pack = writePack(plan.objects);
  if (v2) {
    const parts: Buffer[] = [];
    // With `done` the negotiation is finished: git's own upload-pack goes straight to
    // shallow-info/packfile, and real git refuses an acknowledgments section there.
    // Without it, this response is the negotiation answer and carries only the acks.
    if (!sawDone) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine(plan.commonHave ? `ACK ${plan.commonHave}\n` : 'NAK\n'));
      parts.push(PKT_FLUSH);
      return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    }
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(pack));
    parts.push(PKT_FLUSH);
    return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  const { packets, consumed } = decodePkts(body);
  if (consumed !== body.length || packets.length === 0) {
    return sendRaw(res, 400, Buffer.from('malformed pkt-line request\n'), 'text/plain; charset=utf-8');
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (v2) {
    // Split at the delim: command section, then arguments.
    let delimIndex = -1;
    let packetIndex = -1;
    for (const packet of packets) {
      packetIndex += 1;
      if (packet.kind === 'delim') {
        delimIndex = packetIndex;
        break;
      }
    }
    const dataLines: string[] = [];
    const argLines: string[] = [];
    let seen = -1;
    for (const packet of packets) {
      seen += 1;
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (delimIndex >= 0 && seen > delimIndex) argLines.push(line);
      else dataLines.push(line);
    }
    const command = dataLines[0] ?? '';
    if (command === 'command=ls-refs') return handleLsRefs(res, repo, argLines);
    if (command === 'command=fetch') return handleFetch(res, repo, argLines, true);
    return sendRaw(res, 400, Buffer.from('unknown command\n'), 'text/plain; charset=utf-8');
  }
  void lines;
  return handleFetch(res, repo, lines, false);
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  const { packets, consumed } = decodePkts(body);
  const commandLines: string[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind === 'data') commandLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (!sawFlush || commandLines.length === 0) {
    return sendRaw(res, 400, Buffer.from('malformed receive-pack request\n'), 'text/plain; charset=utf-8');
  }
  const packBytes = body.subarray(consumed);

  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = new Set<string>();
  commandLines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean));
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });

  // Unpack first: objects land in the store even when a ref update is then refused,
  // exactly as git's receive-pack keeps the pack and reports per-ref verdicts.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const staged = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of staged) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [unpackError ? `unpack ${unpackError}` : 'unpack ok'];
  for (const command of commands) {
    if (unpackError) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} stale info`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      reportLines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      reportLines.push(`ng ${command.ref} object is not a commit`);
      continue;
    }
    if (current !== ZERO_OID) {
      const newCommit = peelToCommit(repo, command.newOid);
      if (!isAncestor(repo, current, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  if (!capabilities.has('report-status') && !capabilities.has('report-status-v2')) {
    return sendRaw(res, 200, PKT_FLUSH, 'application/x-git-receive-pack-result');
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    return sendRaw(res, 200, Buffer.concat([sidebandWrap(report), PKT_FLUSH]), 'application/x-git-receive-pack-result');
  }
  return sendRaw(res, 200, report, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and executor over the same store
// ---------------------------------------------------------------------------

/** Opaque, stable global ids (never the plain database id or issue number). */
function gid(kind: string, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function parseGid(value: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

type GqlValue =
  | { t: 'var'; name: string }
  | { t: 'lit'; value: unknown }
  | { t: 'list'; items: GqlValue[] }
  | { t: 'object'; fields: Record<string, GqlValue> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; typeCondition: string; selection: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  opType: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection[];
}

interface GqlToken {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function lexGraphql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else text += esc;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  private tokens: GqlToken[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lexGraphql(source);
  }

  private peek(): GqlToken {
    return this.tokens[this.pos];
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', got '${token.value}'`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ opType: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.next();
      if (keyword.kind !== 'name') throw new Error(`unexpected token '${keyword.value}'`);
      if (keyword.value === 'query' || keyword.value === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipBalancedParens();
        this.skipDirectives();
        operations.push({ opType: keyword.value, name, selection: this.parseSelectionSet() });
      } else if (keyword.value === 'fragment') {
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('fragment definition is missing ON');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unsupported definition '${keyword.value}'`);
      }
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // directive name
      if (this.atPunct('(')) this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().kind === 'spread') {
      this.next();
      const nameToken = this.next();
      if (nameToken.kind === 'name' && nameToken.value === 'on') {
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: nameToken.value };
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.next();
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { t: 'var', name: this.next().value };
    }
    if (token.kind === 'string') return { t: 'lit', value: token.value };
    if (token.kind === 'number') return { t: 'lit', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'lit', value: true };
      if (token.value === 'false') return { t: 'lit', value: false };
      if (token.value === 'null') return { t: 'lit', value: null };
      return { t: 'lit', value: token.value }; // an enum, carried as its name
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.next();
      return { t: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!this.atPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.next();
      return { t: 'object', fields };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.t) {
    case 'var':
      return variables[value.name];
    case 'lit':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

// ----- GraphQL nodes and resolvers -----

type GqlNode = Record<string, unknown> & { __typename: string };
type GqlResolver = (source: GqlNode, args: Record<string, unknown>) => unknown;

function nodeOf(typename: string, fields: Record<string, unknown>): GqlNode {
  return { __typename: typename, ...fields };
}

function userNode(user: UserRec): GqlNode {
  return nodeOf('User', { login: user.login, id: gid('User', user.login), name: user.name, email: user.email });
}

function repoNode(repo: RepoRec): GqlNode {
  return nodeOf('Repository', { repo });
}

function issueNode(repo: RepoRec, issue: IssueRec): GqlNode {
  return nodeOf('Issue', { repo, issue });
}

function pullNode(repo: RepoRec, pull: PullRec): GqlNode {
  return nodeOf('PullRequest', { repo, pull });
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): GqlNode {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((entry) => String(entry)) : [];
  if (states.length) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const desc = orderBy.direction === 'DESC';
  list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const number = decodeCursor(args.after);
    const index = number === null ? -1 : list.findIndex((issue) => issue.number === number);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const page = list.slice(start, start + first);
  return nodeOf('IssueConnection', {
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: nodeOf('PageInfo', {
      hasNextPage: start + page.length < list.length,
      endCursor: page.length ? encodeCursor(page[page.length - 1].number) : null,
    }),
  });
}

const TYPE_DEFS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'] },
};

function typeIntrospection(name: string): GqlNode | null {
  const def = TYPE_DEFS[name];
  if (!def) return null;
  return nodeOf('__Type', {
    name,
    kind: def.kind,
    fields: def.fields ? def.fields.map((field) => nodeOf('__Field', { name: field })) : null,
    enumValues: def.enumValues ? def.enumValues.map((value) => nodeOf('__EnumValue', { name: value })) : null,
  });
}

function nodeByGlobalId(value: string): GqlNode | null {
  const parsed = parseGid(value);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const repo = reposById.get(Number(parsed.key));
    return repo ? repoNode(repo) : null;
  }
  if (parsed.kind === 'User') {
    const user = USERS[parsed.key];
    return user ? userNode(user) : null;
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':').map(Number);
    const repo = reposById.get(repoId);
    if (!repo) return null;
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueNode(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullNode(repo, pull) : null;
  }
  return null;
}

function repoByGlobalId(value: unknown): RepoRec | null {
  if (typeof value !== 'string') return null;
  const parsed = parseGid(value);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return reposById.get(Number(parsed.key)) ?? null;
}

const prop = (key: string): GqlResolver => (source) => source[key] ?? null;

const GQL_RESOLVERS: Record<string, Record<string, GqlResolver>> = {
  Query: {
    viewer: () => userNode(VIEWER),
    repository: (_source, args) => {
      const repo = getRepo(str(args.owner), str(args.name));
      return repo ? repoNode(repo) : null;
    },
    node: (_source, args) => nodeByGlobalId(str(args.id)),
    __type: (_source, args) => typeIntrospection(str(args.name)),
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoByGlobalId(input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const issue = createIssue(repo, str(input.title), str(input.body), []);
      return nodeOf('CreateIssuePayload', { issue: issueNode(repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = nodeByGlobalId(str(input.issueId));
      if (!node || node.__typename !== 'Issue') throw new Error('issue not found');
      const issue = node.issue as IssueRec;
      issue.state = 'closed';
      return nodeOf('CloseIssuePayload', { issue: node, clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoByGlobalId(input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const outcome = createPull(repo, {
        title: str(input.title),
        body: str(input.body),
        head: str(input.headRefName),
        base: str(input.baseRefName),
      });
      if (!outcome.ok) throw new Error(outcome.message);
      return nodeOf('CreatePullRequestPayload', { pullRequest: pullNode(repo, outcome.pull), clientMutationId: input.clientMutationId ?? null });
    },
    mergePullRequest: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = nodeByGlobalId(str(input.pullRequestId));
      if (!node || node.__typename !== 'PullRequest') throw new Error('pull request not found');
      const repo = node.repo as RepoRec;
      const pull = node.pull as PullRec;
      const outcome = performMerge(repo, pull, input.mergeMethod === 'MERGE' ? 'merge' : 'squash');
      if (!outcome.ok) throw new Error(outcome.message);
      return nodeOf('MergePullRequestPayload', { pullRequest: node, clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = nodeByGlobalId(str(input.subjectId));
      if (!node || node.__typename !== 'Issue') throw new Error('subject not found');
      const repo = node.repo as RepoRec;
      const issue = node.issue as IssueRec;
      const comment: CommentRec = { id: nextCommentId++, body: str(input.body), seq: globalSeq++ };
      issue.comments.push(comment);
      return nodeOf('AddCommentPayload', {
        commentEdge: nodeOf('CommentEdge', {
          node: nodeOf('IssueComment', { id: gid('IssueComment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body }),
        }),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  },
  User: { login: prop('login'), id: prop('id'), name: prop('name'), email: prop('email') },
  Repository: {
    id: (source) => gid('Repository', (source.repo as RepoRec).id),
    databaseId: (source) => (source.repo as RepoRec).id,
    name: (source) => (source.repo as RepoRec).name,
    nameWithOwner: (source) => `${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}`,
    owner: (source) => {
      const repo = source.repo as RepoRec;
      return userNode(USERS[repo.owner] ?? { id: 2000, login: repo.owner, name: repo.owner, email: '' });
    },
    defaultBranchRef: (source) => nodeOf('Ref', { name: (source.repo as RepoRec).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (source) => (source.repo as RepoRec).createdAt,
    issue: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (source, args) => issuesConnection(source.repo as RepoRec, args),
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullNode(repo, pull) : null;
    },
    pullRequests: (source, args) => {
      const repo = source.repo as RepoRec;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : pulls.length;
      return nodeOf('PullRequestConnection', { nodes: pulls.slice(0, first).map((pull) => pullNode(repo, pull)) });
    },
  },
  Issue: {
    id: (source) => gid('Issue', `${(source.repo as RepoRec).id}:${(source.issue as IssueRec).number}`),
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => (source.issue as IssueRec).state.toUpperCase(),
    createdAt: (source) => (source.issue as IssueRec).createdAt,
    updatedAt: (source) => (source.issue as IssueRec).createdAt,
  },
  PullRequest: {
    id: (source) => gid('PullRequest', `${(source.repo as RepoRec).id}:${(source.pull as PullRec).number}`),
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullRec).merged,
    mergeable: (source) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      if (pull.merged) return 'UNKNOWN';
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (!baseTip || !headTip) return 'UNKNOWN';
      return mergeability(repo, baseTip, headTip).mergeable ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (source) => (source.pull as PullRec).headRef,
    baseRefName: (source) => (source.pull as PullRec).baseRef,
    createdAt: (source) => (source.pull as PullRec).createdAt,
    updatedAt: (source) => (source.pull as PullRec).createdAt,
    files: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const changes = diffCommits(repo, pull.baseSha, headTip);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
      return nodeOf('PullRequestFileConnection', {
        nodes: changes.slice(0, first).map((change) => nodeOf('PullRequestChangedFile', { path: change.filename })),
      });
    },
  },
  Ref: { name: prop('name') },
  PageInfo: { hasNextPage: prop('hasNextPage'), endCursor: prop('endCursor') },
  IssueConnection: { nodes: prop('nodes'), pageInfo: prop('pageInfo') },
  PullRequestConnection: { nodes: prop('nodes') },
  PullRequestFileConnection: { nodes: prop('nodes') },
  PullRequestChangedFile: { path: prop('path') },
  IssueComment: { id: prop('id'), body: prop('body') },
  CommentEdge: { node: prop('node') },
  CreateIssuePayload: { issue: prop('issue'), clientMutationId: prop('clientMutationId') },
  CloseIssuePayload: { issue: prop('issue'), clientMutationId: prop('clientMutationId') },
  CreatePullRequestPayload: { pullRequest: prop('pullRequest'), clientMutationId: prop('clientMutationId') },
  MergePullRequestPayload: { pullRequest: prop('pullRequest'), clientMutationId: prop('clientMutationId') },
  AddCommentPayload: { commentEdge: prop('commentEdge'), clientMutationId: prop('clientMutationId') },
  __Type: { name: prop('name'), kind: prop('kind'), fields: prop('fields'), enumValues: prop('enumValues') },
  __Field: { name: prop('name') },
  __EnumValue: { name: prop('name') },
};

interface GqlExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
  errors: Array<{ message: string }>;
}

function executeSelection(source: GqlNode, selections: readonly GqlSelection[], ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = source.__typename;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === typename) Object.assign(out, executeSelection(source, selection.selection, ctx));
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === typename) {
        Object.assign(out, executeSelection(source, fragment.selection, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typename;
      continue;
    }
    const resolver = GQL_RESOLVERS[typename]?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(field.args)) args[argName] = resolveValue(argValue, ctx.variables);
    let value: unknown;
    try {
      value = resolver(source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field.selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: GqlSelection[] | null, ctx: GqlExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (!selection) return value;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelection(value as GqlNode, selection, ctx);
  }
  return value;
}

function executeGraphqlOperation(body: Record<string, unknown>): Record<string, unknown> {
  const query = str(body.query);
  if (query === '') return { errors: [{ message: 'query is required' }] };
  const variables = isRecord(body.variables) ? body.variables : {};
  let document: { operations: GqlOperation[]; fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }> };
  try {
    document = new GqlParser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = str(body.operationName);
  const operation = document.operations.find((candidate) => candidate.name === operationName)
    ?? (operationName === '' ? document.operations[0] : undefined);
  if (!operation) return { errors: [{ message: 'operation not found' }] };
  const ctx: GqlExecContext = { variables, fragments: document.fragments, errors: [] };
  const root = nodeOf(operation.opType === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelection(root, operation.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return messageError(res, 404, 'Not Found');
  if (!authorized(req)) return messageError(res, 401, 'Bad credentials');
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { errors: [{ message: 'invalid JSON' }] });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeGraphqlOperation(isRecord(entry) ? entry : {}));
    return sendJson(res, 200, results);
  }
  if (!isRecord(parsed)) return sendJson(res, 400, { errors: [{ message: 'invalid request' }] });
  return sendJson(res, 200, executeGraphqlOperation(parsed));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over POST /mcp, plain JSON answers (no SSE)
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch to merge from.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

interface McpOutcome {
  result?: unknown;
  rpcError?: { code: number; message: string };
}

function mcpToolSuccess(value: unknown): McpOutcome {
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    },
  };
}

function mcpToolError(message: string): McpOutcome {
  return { result: { content: [{ type: 'text', text: message }], isError: true } };
}

function mcpCallTool(params: Record<string, unknown>): McpOutcome {
  const name = str(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcError: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  const repoOf = (): RepoRec | null => getRepo(str(args.owner), str(args.repo)) ?? null;

  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      const existing = getRepo(VIEWER.login, repoName);
      if (existing) return mcpToolSuccess(repoJson(existing));
      const repo = createRepo(VIEWER.login, repoName, str(args.description), args.private === true);
      return mcpToolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      return mcpToolSuccess(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const issue = createIssue(repo, str(args.title), str(args.body), []);
      return mcpToolSuccess(issueJson(issue, repo));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = str(args.state) || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.seq - a.seq);
      return mcpToolSuccess(issues.map((issue) => issueJson(issue, repo)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const outcome = createPull(repo, { title: str(args.title), body: str(args.body), head: str(args.head), base: str(args.base) });
      if (!outcome.ok) return mcpToolError(outcome.message);
      return mcpToolSuccess(pullJson(repo, outcome.pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return mcpToolError(`Pull request ${String(args.pull_number)} not found`);
      const outcome = performMerge(repo, pull, 'squash');
      if (!outcome.ok) return mcpToolError(outcome.message);
      return mcpToolSuccess(pullJson(repo, pull));
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function mcpDispatch(request: Record<string, unknown>): McpOutcome {
  const method = str(request.method);
  const params = isRecord(request.params) ? request.params : {};
  switch (method) {
    case 'server/discover':
      return {
        result: {
          resultType: 'complete',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        },
      };
    case 'initialize': {
      const offered = str(params.protocolVersion);
      const chosen = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return { result: { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO } };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: MCP_TOOLS } };
    case 'tools/call':
      return mcpCallTool(params);
    default:
      return { rpcError: { code: -32601, message: `Method not found: ${method}` } };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  if (req.method !== 'POST') return messageError(res, 405, 'Method Not Allowed');
  if (!authorized(req)) {
    return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unauthorized' } });
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    if (!isRecord(entry)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    if (entry.id === undefined) return null; // a notification: no answer body
    const outcome = mcpDispatch(entry);
    if (outcome.rpcError) return { jsonrpc: '2.0', id: entry.id, error: outcome.rpcError };
    return { jsonrpc: '2.0', id: entry.id, result: outcome.result ?? {} };
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(handleOne).filter((entry) => entry !== null);
    return sendJson(res, 200, results);
  }
  const single = handleOne(parsed);
  if (single === null) {
    res.writeHead(202, { 'content-length': 0 });
    return res.end();
  }
  return sendJson(res, 200, single);
}

// ---------------------------------------------------------------------------
// the top-level router
// ---------------------------------------------------------------------------

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const method = req.method ?? 'GET';

  if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  if (segments.length === 1 && segments[0] === 'mcp') {
    return handleMcp(req, res);
  }

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    return handleGraphql(req, res);
  }

  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) return messageError(res, 401, 'Bad credentials');
    const host = req.headers.host ?? '127.0.0.1';
    return handleRest(
      { req, res, query: url.searchParams, origin: `http://${host}`, pathname: url.pathname },
      segments,
    );
  }

  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    if (!authorized(req)) return messageError(res, 401, 'Bad credentials');
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const repo = getRepo(owner, repoName);
    if (!repo) return messageError(res, 404, 'Not Found');
    const tail = segments.slice(2);
    if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return messageError(res, 400, 'Unknown service');
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      return handleInfoRefs(res, repo, service, wantsV2);
    }
    if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
      return handleUploadPack(req, res, repo);
    }
    if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
      return handleReceivePack(req, res, repo);
    }
    return messageError(res, 404, 'Not Found');
  }

  return messageError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// lifecycle: listen, register, poll /done, exit 0
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      process.stderr.write(`forge: request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) messageError(res, 500, 'Internal error');
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stderr.write(`forge: listening on ${port}\n`);

  if (ENV_URL === '') return; // a local run: serve until killed

  let registered = false;
  for (let attempt = 0; attempt < 40 && !registered; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await response.text().catch(() => undefined);
      registered = response.ok;
    } catch {
      registered = false;
    }
    if (!registered) await sleep(250);
  }

  let failures = 0;
  for (;;) {
    await sleep(200);
    try {
      const response = await fetch(`${ENV_URL}/done`);
      const body: unknown = await response.json().catch(() => null);
      failures = 0;
      if (isRecord(body) && body.done === true) break;
    } catch {
      failures += 1;
      if (failures > 150) break; // the env is gone; the trial is over either way
    }
  }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

void main();
