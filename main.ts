// forge-v2: a single-process GitHub-compatible git forge (git smart HTTP v2/v0,
// REST v3, GraphQL v4, MCP) built for raw per-request speed.
//
// Design notes (the perf rewrite):
//   * Everything lives in memory. No filesystem, no child processes, no deps
//     beyond node:http, node:crypto and node:zlib.
//   * Hot GETs never re-serialise: an issue's REST JSON is rendered once when
//     the issue is created or mutated and the finished Buffer is served
//     verbatim on every later read (the read workload is 2,000 of those).
//   * Packfiles are assembled from per-object segments (pack header + zlib
//     stream) that are cached by object id, and a whole fetch pack is cached
//     per repository keyed by its wants/haves/depth signature, so 50
//     concurrent shallow clones of one tip share a single built pack.
//   * zlib runs at level 1 everywhere: the wire cares about bytes parsing,
//     not about squeezing them.
//   * Routing is plain string surgery on the path; no URL machinery on the
//     git paths, no framework, no per-request allocations we can avoid.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants

const ZERO_OID = '0000000000000000000000000000000000000000';
const FIXED_TIME = '2026-01-01T00:00:00Z';
const COMMIT_EPOCH = 1767225600; // fixed base for our own commits' timestamps
const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const BODY_NOT_FOUND = Buffer.from('{"message":"Not Found"}\n');
const BODY_BAD_JSON = Buffer.from('{"message":"Problems parsing JSON"}\n');
const BODY_UNAUTH = Buffer.from('{"message":"Requires authentication"}\n');
const BODY_ROOT = Buffer.from('{"current_user_url":"/api/v3/user","repository_url":"/api/v3/repos/{owner}/{repo}","issue_search_url":"/api/v3/search/issues"}\n');
const BODY_META = Buffer.from('{"installed_version":"2.0.0","verifiable_password_authentication":false}\n');
const BODY_HEALTH = Buffer.from('{"ok":true}\n');
const BODY_UNAUTHORIZED = Buffer.from('{"message":"Requires authentication"}\n');
const BODY_INTERNAL = Buffer.from('{"message":"Internal Server Error"}\n');

// ---------------------------------------------------------------------------
// small helpers

let requestSeq = 0;

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function oidOf(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Escape a string for embedding inside a JSON string literal. */
function jsonStr(value: string): string {
  return JSON.stringify(value);
}

/** Send a finished Buffer; `extra` headers are merged over the defaults. */
function sendBuf(res: ServerResponse, status: number, body: Buffer, type: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'x-github-request-id': `f2-${++requestSeq}`,
    ...(extra ?? {}),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  sendBuf(res, status, Buffer.from(`${JSON.stringify(value)}\n`), JSON_TYPE, extra);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendBuf(res, status, Buffer.from(`{"message":${jsonStr(message)}}\n`), JSON_TYPE);
}

/** Read a whole request body (git packs are binary; JSON bodies are small). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body: {ok:false} is the protocol group's 400 case. */
function parseJsonBody(raw: Buffer): { ok: boolean; value: Record<string, unknown> } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, value: {} };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decodeSeg(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a request target into decoded path segments and a raw query string. */
function splitTarget(target: string): { segments: string[]; query: string } {
  const q = target.indexOf('?');
  const path = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? '' : target.slice(q + 1);
  const parts = path.split('/');
  const segments: string[] = [];
  for (const part of parts) if (part !== '') segments.push(decodeSeg(part));
  return { segments, query };
}

function queryParam(query: string, name: string): string | null {
  if (query === '') return null;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key === name) {
      const raw = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        return decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        return raw;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// the store

interface GitObj {
  t: string; // commit | tree | blob | tag
  d: Buffer;
}

interface IssueRec {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: string; // open | closed
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  json: Buffer | null; // cached REST rendering, invalidated on any mutation
}

interface PullRec {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: string; // open | closed
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergeCommitSha: string | null;
}

interface Repo {
  dbId: number;
  name: string;
  owner: string | null; // claimed by the first owner-named request that finds it
  priv: boolean;
  desc: string;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number; // issues and pull requests share one sequence, as on GitHub
  nextCommentId: number;
  commitSeq: number;
  packCache: Map<string, Buffer>;
  commitCache: Map<string, { tree: string; parents: string[] }>;
}

const reposByName = new Map<string, Repo>();
const reposByDbId = new Map<number, Repo>();
let nextRepoDbId = 1;
let nextDbId = 1000;
let viewerLogin: string | null = null;

function createRepoRec(name: string, priv: boolean, desc: string): Repo {
  const repo: Repo = {
    dbId: nextRepoDbId++,
    name,
    owner: null,
    priv,
    desc,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    commitSeq: 0,
    packCache: new Map(),
    commitCache: new Map(),
  };
  reposByName.set(name, repo);
  reposByDbId.set(repo.dbId, repo);
  return repo;
}

/**
 * A repository belongs to the login the token names. Creation carries no
 * owner, so the first owner-named request claims the name; a different owner
 * asking for the same name afterwards is a 404, never a 403.
 */
function claimRepo(repo: Repo, owner: string): boolean {
  if (repo.owner === null) {
    repo.owner = owner;
    if (viewerLogin === null) viewerLogin = owner;
    return true;
  }
  return repo.owner === owner;
}

function repoOwner(repo: Repo): string {
  return repo.owner ?? viewerLogin ?? 'viewer';
}

function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// git object model

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function storeObject(repo: Repo, type: string, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { t: type, d: data });
  return oid;
}

function parseCommit(repo: Repo, oid: string): { tree: string; parents: string[] } | null {
  const cached = repo.commitCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.t !== 'commit') return null;
  const text = obj.d.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const parsed = { tree, parents };
  repo.commitCache.set(oid, parsed);
  return parsed;
}

function commitMessage(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return '';
  const text = obj.d.toString('utf8');
  const blank = text.indexOf('\n\n');
  const message = blank === -1 ? '' : text.slice(blank + 2);
  return message.replace(/\n+$/, '');
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
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree ordering: by name, directories compared with a trailing '/'. */
function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Follow tag objects until a non-tag object; returns the final oid. */
function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.t !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.d.toString('utf8'));
    if (match === null) return current;
    current = match[1];
  }
  return current;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  const target = peel(repo, oid);
  const obj = repo.objects.get(target);
  return obj !== undefined && obj.t === 'commit' ? target : null;
}

/** True when `ancestor` is `descendant` itself or reachable through its parents. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const start = peelToCommit(repo, descendant);
  const goal = peelToCommit(repo, ancestor);
  if (start === null || goal === null) return ancestor === descendant;
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const parsed = parseCommit(repo, current);
    if (parsed !== null) for (const parent of parsed.parents) stack.push(parent);
  }
  return false;
}

/** Every ancestor commit of `tip`, tip first (breadth-first). */
function ancestorsOf(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    order.push(current);
    const parsed = parseCommit(repo, current);
    if (parsed !== null) for (const parent of parsed.parents) queue.push(parent);
  }
  return order;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Set(ancestorsOf(repo, a));
  for (const candidate of ancestorsOf(repo, b)) if (ancestors.has(candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// tree flatten / rebuild, for the contents API and merges

type FlatTree = Map<string, { mode: string; oid: string }>;

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: FlatTree): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.t !== 'tree') return;
  for (const entry of parseTree(obj.d)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

function flatOfCommit(repo: Repo, commitOid: string | null): FlatTree {
  const out: FlatTree = new Map();
  if (commitOid === null) return out;
  const parsed = parseCommit(repo, commitOid);
  if (parsed !== null) flattenTree(repo, parsed.tree, '', out);
  return out;
}

function buildTreeFromFlat(repo: Repo, flat: FlatTree): string {
  interface Node {
    files: Array<{ name: string; mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let child = node.dirs.get(segments[i]);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(segments[i], child);
      }
      node = child;
    }
    node.files.push({ name: segments[segments.length - 1], mode: entry.mode, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** Create one of our own commits on a ref, applying `mutate` to its flat tree. */
function commitWithTree(
  repo: Repo,
  parentOid: string | null,
  flat: FlatTree,
  message: string,
): string {
  const treeOid = buildTreeFromFlat(repo, flat);
  repo.commitSeq += 1;
  const stamp = COMMIT_EPOCH + repo.commitSeq;
  const who = `Forge Bot <forge@localhost> ${stamp} +0000`;
  const lines = [`tree ${treeOid}`];
  if (parentOid !== null) lines.push(`parent ${parentOid}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

// ---------------------------------------------------------------------------
// packfiles

/** Per-object pack segments (header + zlib stream), cached by object id. */
const segmentCache = new Map<string, Buffer>();

function packObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type] ?? 3;
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function packSegment(oid: string, obj: GitObj): Buffer {
  const cached = segmentCache.get(oid);
  if (cached !== undefined) return cached;
  const segment = Buffer.concat([packObjectHeader(obj.t, obj.d.length), deflateSync(obj.d, { level: 1 })]);
  if (segmentCache.size < 200000) segmentCache.set(oid, segment);
  return segment;
}

function buildPack(entries: Array<{ oid: string; obj: GitObj }>): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) parts.push(packSegment(entry.oid, entry.obj));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** The git delta instruction stream, applied to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readSize(); // base size, the caller verified the base
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  code: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
  resolved?: GitObj;
  resolvedOid?: string;
}

/** Parse a received pack and store every resolved object in the repository. */
function ingestPack(repo: Repo, pack: Buffer): void {
  if (pack.length === 0) return;
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (code === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (code === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    const entry: RawPackEntry = { code, data: inflated.data, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const byOid = new Map<string, GitObj>();
  const resolve = (entry: RawPackEntry): GitObj => {
    if (entry.resolved !== undefined) return entry.resolved;
    let resolved: GitObj;
    if (entry.code === 6 || entry.code === 7) {
      let base: GitObj | undefined;
      if (entry.code === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry);
      } else {
        base = byOid.get(entry.baseOid) ?? repo.objects.get(entry.baseOid);
        if (base === undefined) throw new Error('ref-delta base missing');
      }
      resolved = { t: base.t, d: applyDelta(base.d, entry.data) };
    } else {
      const type = CODE_TYPE[entry.code];
      if (type === undefined) throw new Error(`unknown pack type ${entry.code}`);
      resolved = { t: type, d: entry.data };
    }
    entry.resolved = resolved;
    entry.resolvedOid = oidOf(resolved.t, resolved.d);
    byOid.set(entry.resolvedOid, resolved);
    return resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    const oid = entry.resolvedOid as string;
    if (!repo.objects.has(oid)) repo.objects.set(oid, resolved);
  }
}

// ---------------------------------------------------------------------------
// pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-lines from the front of `buf`; `rest` is what follows the first flush. */
function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line');
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, rest: buf.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Parse a whole body as pkt-lines (upload-pack requests carry nothing else). */
function parseAllPackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line');
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function packetText(packet: Packet): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// git smart HTTP

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertiseV0(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow agent=forge/2.0 symref=HEAD:${headTarget(repo)} object-format=sha1`
      : 'report-status delete-refs side-band-64k ofs-delta agent=forge/2.0';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    let first = true;
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    first = false;
    void first;
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(pkt(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.t === 'tag') {
        const target = peel(repo, oid);
        if (target !== oid) parts.push(pkt(`${target} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=forge/2.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, query: string): void {
  const service = queryParam(query, 'service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, 'unknown service');
    return;
  }
  const protocol = req.headers['git-protocol'];
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  const body = wantsV2 && service === 'git-upload-pack' ? advertiseV2() : advertiseV0(repo, service);
  sendBuf(res, 200, body, `application/x-${service}-advertisement`);
}

/** One ls-refs answer line for a ref, honouring peel/symref decoration. */
function lsRefLines(repo: Repo, args: Set<string>, prefixes: string[]): Buffer[] {
  const lines: Buffer[] = [];
  const peelWanted = args.has('peel');
  const symrefsWanted = args.has('symrefs');
  const unbornWanted = args.has('unborn');
  const headIncluded = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  const target = headTarget(repo);
  if (headIncluded) {
    const headOid = repo.refs.get(target);
    if (headOid !== undefined) {
      lines.push(pkt(`${headOid} HEAD${symrefsWanted ? ` symref-target:${target}` : ''}\n`));
    } else if (unbornWanted) {
      lines.push(pkt(`unborn HEAD${symrefsWanted ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    const obj = repo.objects.get(oid);
    if (peelWanted && obj !== undefined && obj.t === 'tag') {
      const targetOid = peel(repo, oid);
      if (targetOid !== oid) suffix = ` peeled:${targetOid}`;
    }
    lines.push(pkt(`${oid} ${name}${suffix}\n`));
  }
  return lines;
}

// --- fetch object selection -------------------------------------------------

interface FetchSelection {
  entries: Array<{ oid: string; obj: GitObj }>;
  shallow: string[];
  unshallow: string[];
}

function emitTreeClosure(repo: Repo, treeOid: string, excluded: Set<string>, emit: Map<string, GitObj>): void {
  if (excluded.has(treeOid) || emit.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.t !== 'tree') return;
  emit.set(treeOid, obj);
  for (const entry of parseTree(obj.d)) {
    if (entry.mode === '40000') emitTreeClosure(repo, entry.oid, excluded, emit);
    else if (!excluded.has(entry.oid)) {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined) emit.set(entry.oid, blob);
    }
  }
}

/**
 * The objects a fetch must carry: the closure of the wants, minus the closure
 * of the haves (whose traversal stops at the client's shallow boundaries),
 * cut at `depth` generations of commits when a depth is given.
 */
function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  depth: number | null,
): FetchSelection {
  const boundary = new Set(shallowReq);
  const excluded = new Set<string>();
  const boundaryExcluded = new Set<string>();

  const excludeTree = (treeOid: string): void => {
    if (excluded.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.t !== 'tree') return;
    excluded.add(treeOid);
    for (const entry of parseTree(obj.d)) {
      if (entry.mode === '40000') excludeTree(entry.oid);
      else excluded.add(entry.oid);
    }
  };
  const excludeStack = [...haves];
  const excludeSeen = new Set<string>();
  while (excludeStack.length > 0) {
    const oid = excludeStack.pop() as string;
    if (excludeSeen.has(oid)) continue;
    excludeSeen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.t === 'tag') {
      excluded.add(oid);
      excludeStack.push(peel(repo, oid));
      continue;
    }
    if (obj.t !== 'commit') continue;
    excluded.add(oid);
    const parsed = parseCommit(repo, oid);
    if (parsed === null) continue;
    excludeTree(parsed.tree);
    if (boundary.has(oid)) {
      boundaryExcluded.add(oid);
      continue; // the client holds this commit shallowly: its parents are not held
    }
    for (const parent of parsed.parents) excludeStack.push(parent);
  }

  const emit = new Map<string, GitObj>();
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();
  interface Queued {
    oid: string;
    gen: number;
  }
  const queue: Queued[] = wants.map((oid) => ({ oid, gen: 1 }));
  const seenGen = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as Queued;
    const previous = seenGen.get(oid);
    if (previous !== undefined && previous <= gen) continue;
    seenGen.set(oid, gen);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.t === 'tag') {
      if (!excluded.has(oid)) emit.set(oid, obj);
      queue.push({ oid: peel(repo, oid), gen });
      continue;
    }
    if (obj.t !== 'commit') {
      if (!excluded.has(oid)) emit.set(oid, obj);
      continue;
    }
    const isExcluded = excluded.has(oid);
    const parsed = parseCommit(repo, oid);
    if (parsed === null) continue;
    if (!isExcluded) {
      emit.set(oid, obj);
      emitTreeClosure(repo, parsed.tree, excluded, emit);
    }
    const atDepthLimit = depth !== null && gen >= depth;
    if (atDepthLimit) {
      if (!isExcluded && parsed.parents.length > 0) shallowOut.add(oid);
      continue;
    }
    if (boundary.has(oid)) unshallowOut.add(oid);
    if (isExcluded && !boundaryExcluded.has(oid)) continue; // whole ancestry already held
    for (const parent of parsed.parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  return {
    entries: [...emit.entries()].map(([oid, obj]) => ({ oid, obj })),
    shallow: [...shallowOut],
    unshallow: [...unshallowOut],
  };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

function fetchPackFor(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  depth: number | null,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = [
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    [...shallowReq].sort().join(','),
    depth === null ? 'full' : `d${depth}`,
  ].join('|');
  const cached = repo.packCache.get(key);
  if (cached !== undefined) {
    const selection = selectFetchObjects(repo, wants, haves, shallowReq, depth);
    return { pack: cached, shallow: selection.shallow, unshallow: selection.unshallow };
  }
  const selection = selectFetchObjects(repo, wants, haves, shallowReq, depth);
  const pack = buildPack(selection.entries);
  if (repo.packCache.size < 4096) repo.packCache.set(key, pack);
  return { pack, shallow: selection.shallow, unshallow: selection.unshallow };
}

function handleUploadPack(res: ServerResponse, repo: Repo, raw: Buffer): void {
  const packets = parseAllPackets(raw);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const isV2 = firstData !== undefined && packetText(firstData).startsWith('command=');

  if (isV2) {
    // sections: capability lines to the delim, argument lines to the flush
    let index = 0;
    const capLines: string[] = [];
    while (index < packets.length && packets[index].kind === 'data') {
      capLines.push(packetText(packets[index]));
      index += 1;
    }
    if (index < packets.length && packets[index].kind === 'delim') index += 1;
    const argLines: string[] = [];
    while (index < packets.length && packets[index].kind === 'data') {
      argLines.push(packetText(packets[index]));
      index += 1;
    }
    const command = (capLines[0] ?? '').replace('command=', '');
    if (command === 'ls-refs') {
      const args = new Set<string>();
      const prefixes: string[] = [];
      for (const line of argLines) {
        if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
        else args.add(line);
      }
      const lines = lsRefLines(repo, args, prefixes);
      sendBuf(res, 200, Buffer.concat([...lines, PKT_FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowReq: string[] = [];
      let depth: number | null = null;
      for (const line of argLines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10) || null;
      }
      const { pack, shallow, unshallow } = fetchPackFor(repo, wants, haves, shallowReq, depth);
      const parts: Buffer[] = [pkt('acknowledgments\n')];
      const common = haves.filter((have) => repo.objects.has(have));
      if (common.length > 0) {
        for (const have of common) parts.push(pkt(`ACK ${have}\n`));
        parts.push(pkt('ready\n'));
      } else {
        parts.push(pkt('NAK\n'));
      }
      parts.push(PKT_FLUSH);
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pkt('shallow-info\n'));
        for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
        parts.push(PKT_FLUSH);
      }
      parts.push(pkt('packfile\n'));
      parts.push(...sidebandPackets(pack));
      parts.push(PKT_FLUSH);
      sendBuf(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    sendError(res, 400, `unknown command ${command}`);
    return;
  }

  // v0: want section to a flush, negotiation section to a second flush
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10) || null;
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5, 45));
    }
  }
  const { pack, shallow, unshallow } = fetchPackFor(repo, wants, haves, shallowReq, depth);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBuf(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(res: ServerResponse, repo: Repo, raw: Buffer): void {
  const { packets, rest } = parsePackets(raw);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      const caps = line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const fields = line.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      ingestPack(repo, rest);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  let refsChanged = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const refuse = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      refuse('unpacker error');
      continue;
    }
    if (command.oldOid !== current) {
      refuse('ref update failed');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      refsChanged = true;
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      refuse('invalid object');
      continue;
    }
    if (
      command.oldOid !== ZERO_OID &&
      command.ref.startsWith('refs/heads/') &&
      !isAncestor(repo, command.oldOid, command.newOid)
    ) {
      refuse('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refsChanged = true;
    reportLines.push(`ok ${command.ref}\n`);
  }
  if (refsChanged) repo.packCache.clear();

  const report = Buffer.concat([...reportLines.map((line) => pkt(line)), PKT_FLUSH]);
  const body = sideband
    ? Buffer.concat([...sidebandPackets(report), PKT_FLUSH])
    : report;
  sendBuf(res, 200, body, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// REST v3

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repoOwner(repo);
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.priv,
    description: repo.desc,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1, type: 'User' },
    html_url: `/${owner}/${repo.name}`,
    clone_url: `/${owner}/${repo.name}.git`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: 0,
    size: 0,
    fork: false,
    archived: false,
    disabled: false,
  };
}

function renderIssue(repo: Repo, issue: IssueRec): Buffer {
  if (issue.json !== null) return issue.json;
  const owner = repoOwner(repo);
  const value = {
    id: issue.dbId,
    node_id: globalId('Issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: owner, id: 1, type: 'User' },
    html_url: `/${owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
  };
  issue.json = Buffer.from(`${JSON.stringify(value)}\n`);
  return issue.json;
}

function issueJsonValue(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return JSON.parse(renderIssue(repo, issue).toString('utf8')) as Record<string, unknown>;
}

function createIssueRec(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    number: repo.nextNumber++,
    dbId: nextDbId++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    json: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Validate labels and create an issue; a string is the 422 message. */
function createIssueChecked(repo: Repo, title: string, body: string, labels: string[]): IssueRec | string {
  for (const name of labels) {
    if (!repo.labels.has(name)) return `Validation Failed: label "${name}" does not exist`;
  }
  return createIssueRec(repo, title, body, labels);
}

function labelsFromBody(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const branch = branchTip(repo, ref);
  if (branch !== null) return branch;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return peelToCommit(repo, ref) ?? ref;
  const full = repo.refs.get(ref);
  if (full !== undefined) return full;
  return null;
}

function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = repoOwner(repo);
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.dbId,
    node_id: globalId('PullRequest', repo.dbId, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged ? FIXED_TIME : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1, type: 'User' },
    html_url: `/${owner}/${repo.name}/pulls/${pull.number}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

/** The changed paths between two commits, with line counts per file. */
function pullFiles(repo: Repo, baseCommit: string | null, headCommit: string | null): Array<Record<string, unknown>> {
  const baseFlat = flatOfCommit(repo, baseCommit);
  const headFlat = flatOfCommit(repo, headCommit);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const files: Array<Record<string, unknown>> = [];
  const lineCount = (oid: string | undefined): number => {
    if (oid === undefined) return 0;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return 0;
    const text = obj.d.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length;
  };
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const additions = after !== undefined && before?.oid !== after.oid ? lineCount(after.oid) : 0;
    const deletions = before !== undefined && after?.oid !== before.oid ? lineCount(before.oid) : 0;
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: before === undefined ? lineCount(after?.oid) : additions,
      deletions: after === undefined ? lineCount(before?.oid) : deletions,
      changes: (before === undefined ? lineCount(after?.oid) : additions) + (after === undefined ? lineCount(before?.oid) : deletions),
    });
  }
  return files;
}

/**
 * Three-way tree merge of head into base. Returns the merged flat tree, or
 * null on a conflict (both sides changed the same path differently).
 */
function threeWayMerge(repo: Repo, baseTipOid: string, headTipOid: string): FlatTree | null {
  const base = mergeBase(repo, baseTipOid, headTipOid);
  const ancFlat = flatOfCommit(repo, base);
  const baseFlat = flatOfCommit(repo, baseTipOid);
  const headFlat = flatOfCommit(repo, headTipOid);
  const paths = new Set<string>([...ancFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  const out: FlatTree = new Map();
  for (const path of paths) {
    const anc = ancFlat.get(path)?.oid;
    const bas = baseFlat.get(path)?.oid;
    const hed = headFlat.get(path)?.oid;
    if (bas === hed) {
      if (bas !== undefined) out.set(path, baseFlat.get(path) as { mode: string; oid: string });
    } else if (anc === bas) {
      if (hed !== undefined) out.set(path, headFlat.get(path) as { mode: string; oid: string });
    } else if (anc === hed) {
      if (bas !== undefined) out.set(path, baseFlat.get(path) as { mode: string; oid: string });
    } else {
      return null;
    }
  }
  return out;
}

/** Merge a pull request; returns {sha} or {error, status}. */
function mergePull(repo: Repo, pull: PullRec, method: string): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'Pull Request is not mergeable', status: 405 };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { error: 'Pull Request is not mergeable', status: 405 };
  if (isAncestor(repo, headTip, baseTip)) {
    // already contained: nothing to merge
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = baseTip;
    return { sha: baseTip };
  }
  const mergedFlat = threeWayMerge(repo, baseTip, headTip);
  if (mergedFlat === null) return { error: 'Pull Request is not mergeable', status: 405 };
  let sha: string;
  if (method === 'merge') {
    const treeOid = buildTreeFromFlat(repo, mergedFlat);
    repo.commitSeq += 1;
    const stamp = COMMIT_EPOCH + repo.commitSeq;
    const who = `Forge Bot <forge@localhost> ${stamp} +0000`;
    const data = Buffer.from(
      `tree ${treeOid}\nparent ${baseTip}\nparent ${headTip}\nauthor ${who}\ncommitter ${who}\n\nMerge pull request #${pull.number}\n`,
      'utf8',
    );
    sha = storeObject(repo, 'commit', data);
  } else {
    sha = commitWithTree(repo, baseTip, mergedFlat, `${pull.title} (#${pull.number})`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  return { sha };
}

function pullMergeable(repo: Repo, pull: PullRec): string {
  if (pull.merged) return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  return threeWayMerge(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

// --- REST routing ------------------------------------------------------------

function treeAtPath(repo: Repo, commitOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  const parsed = parseCommit(repo, commitOid);
  if (parsed === null) return null;
  if (path === '') return { kind: 'dir', oid: parsed.tree, mode: '40000' };
  let current = parsed.tree;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.t !== 'tree') return null;
    const entry = parseTree(obj.d).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: string,
  raw: Buffer,
): void {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const commit = resolveRef(repo, queryParam(query, 'ref'));
    if (commit === null) {
      sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      return;
    }
    const found = treeAtPath(repo, commit, path);
    if (found === null) {
      sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      return;
    }
    if (found.kind === 'file') {
      const obj = repo.objects.get(found.oid);
      if (obj === undefined) {
        sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
        return;
      }
      const name = path.split('/').pop() ?? path;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: obj.d.toString('base64'),
        sha: found.oid,
        size: obj.d.length,
        name,
        path,
      });
      return;
    }
    const dirObj = repo.objects.get(found.oid);
    const entries = dirObj !== undefined && dirObj.t === 'tree' ? parseTree(dirObj.d) : [];
    sendJson(
      res,
      200,
      entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: 0,
      })),
    );
    return;
  }

  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
    return;
  }
  const body = parsed.value;
  const branch = str(body.branch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName) ?? null;
  const flat = new Map(flatOfCommit(repo, parent)); // copy: the cached map must stay immutable
  const existing = flat.get(path);

  if (method === 'PUT') {
    const givenSha = str(body.sha);
    if (existing !== undefined && givenSha !== '' && givenSha !== existing.oid) {
      sendError(res, 409, 'SHA does not match');
      return;
    }
    if (existing !== undefined && givenSha === '') {
      sendError(res, 422, 'Validation Failed: "sha" wasn\'t supplied');
      return;
    }
    const content = Buffer.from(str(body.content), 'base64');
    const blobOid = storeObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', oid: blobOid });
    const commit = commitWithTree(repo, parent, flat, str(body.message) || 'Update file');
    repo.refs.set(refName, commit);
    repo.packCache.clear();
    sendJson(
      res,
      existing !== undefined ? 200 : 201,
      {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commit },
      },
    );
    return;
  }

  if (method === 'DELETE') {
    if (existing === undefined) {
      sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      return;
    }
    const givenSha = str(body.sha);
    if (givenSha !== '' && givenSha !== existing.oid) {
      sendError(res, 409, 'SHA does not match');
      return;
    }
    flat.delete(path);
    const commit = commitWithTree(repo, parent, flat, str(body.message) || 'Delete file');
    repo.refs.set(refName, commit);
    repo.packCache.clear();
    sendJson(res, 200, { content: null, commit: { sha: commit } });
    return;
  }

  sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
}

function pageOf<T>(items: T[], query: string): { page: T[]; nextUrl: string | null; perPage: number; pageNum: number } {
  const perPageRaw = Number.parseInt(queryParam(query, 'per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(queryParam(query, 'page') ?? '', 10);
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  return { page, nextUrl: null, perPage, pageNum };
}

function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: string, raw: Buffer): void {
  const method = req.method ?? 'GET';
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    return void sendBuf(res, 200, BODY_ROOT, JSON_TYPE, { 'x-oauth-scopes': 'repo, read:org, write:org' });
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    return void sendBuf(res, 200, BODY_META, JSON_TYPE);
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    return void sendJson(res, 200, { login: viewerLogin ?? 'viewer', id: 1, type: 'User', name: 'Forge Viewer' });
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...reposByName.values()].sort((a, b) => a.dbId - b.dbId).map((repo) => repoJson(repo));
      const { page, perPage, pageNum } = pageOf(all, query);
      const headers: Record<string, string> = {};
      if (pageNum * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`;
      }
      return void sendJson(res, 200, page, headers);
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
      const name = str(parsed.value.name);
      if (name === '') return void sendError(res, 422, 'Validation Failed: name is required');
      if (reposByName.has(name)) return void sendError(res, 422, 'Repository already exists');
      const repo = createRepoRec(name, parsed.value.private === true, str(parsed.value.description));
      return void sendJson(res, 201, repoJson(repo));
    }
    return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  }

  if (rest[0] !== 'repos' || rest.length < 3) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  const owner = rest[1];
  const repo = reposByName.get(rest[2]);
  if (repo === undefined || !claimRepo(repo, owner)) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  const sub = rest.slice(3);

  if (sub.length === 0) {
    if (method === 'GET') return void sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
      if (typeof parsed.value.description === 'string') repo.desc = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.priv = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== '' && parsed.value.name !== repo.name) {
        reposByName.delete(repo.name);
        repo.name = parsed.value.name;
        reposByName.set(repo.name, repo);
      }
      return void sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      reposByName.delete(repo.name);
      reposByDbId.delete(repo.dbId);
      res.writeHead(204, { 'x-github-request-id': `f2-${++requestSeq}` });
      res.end();
      return;
    }
    return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  }

  if (sub[0] === 'contents') {
    return void handleContents(req, res, repo, sub.slice(1).join('/'), query, raw);
  }

  if (sub[0] === 'labels' && sub.length === 1 && method === 'POST') {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
    const name = str(parsed.value.name);
    if (name === '') return void sendError(res, 422, 'Validation Failed: name is required');
    const color = str(parsed.value.color) || 'ededed';
    repo.labels.set(name, { name, color });
    return void sendJson(res, 201, { name, color, description: null, id: nextDbId++ });
  }
  if (sub[0] === 'labels' && sub.length === 1 && method === 'GET') {
    return void sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
  }

  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (sub.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
      const ref = str(parsed.value.ref);
      const sha = str(parsed.value.sha);
      const obj = repo.objects.get(sha);
      if (!ref.startsWith('refs/') || obj === undefined) return void sendError(res, 422, 'Validation Failed: invalid ref or sha');
      if (repo.refs.has(ref)) return void sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      return void sendJson(res, 201, { ref, node_id: globalId('Ref', repo.dbId, ref), object: { sha, type: obj.t } });
    }
    if (method === 'GET') {
      const ref = `refs/${sub.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      const obj = repo.objects.get(sha);
      return void sendJson(res, 200, { ref, object: { sha, type: obj?.t ?? 'commit' } });
    }
    return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  }

  if (sub[0] === 'branches') {
    if (sub.length === 1 && method === 'GET') {
      const branches = sortedRefNames(repo)
        .filter((name) => name.startsWith('refs/heads/'))
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) }, protected: false }));
      return void sendJson(res, 200, branches);
    }
    const branch = sub.slice(1).join('/');
    const tip = branchTip(repo, branch);
    if (tip === null) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    return void sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  }

  if (sub[0] === 'commits' && sub.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, queryParam(query, 'sha'));
    if (tip === null) return void sendJson(res, 200, []);
    const commits = ancestorsOf(repo, tip)
      .slice(0, 100)
      .map((oid) => {
        const parsedCommit = parseCommit(repo, oid);
        return {
          sha: oid,
          commit: {
            message: commitMessage(repo, oid),
            author: { name: 'Forge Bot', email: 'forge@localhost', date: FIXED_TIME },
            committer: { name: 'Forge Bot', email: 'forge@localhost', date: FIXED_TIME },
            tree: { sha: parsedCommit?.tree ?? ZERO_OID },
          },
          parents: (parsedCommit?.parents ?? []).map((parent) => ({ sha: parent })),
        };
      });
    return void sendJson(res, 200, commits);
  }

  if (sub[0] === 'issues') {
    if (sub.length === 1) {
      if (method === 'GET') {
        const state = queryParam(query, 'state') ?? 'open';
        const direction = queryParam(query, 'direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page } = pageOf(list, query);
        return void sendJson(res, 200, page.map((issue) => issueJsonValue(repo, issue)));
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
        const created = createIssueChecked(repo, str(parsed.value.title), str(parsed.value.body), labelsFromBody(parsed.value));
        if (typeof created === 'string') return void sendError(res, 422, created);
        return void sendBuf(res, 201, renderIssue(repo, created), JSON_TYPE);
      }
      return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    }
    const number = Number.parseInt(sub[1], 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (sub.length === 2) {
      if (issue === undefined) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      if (method === 'GET') return void sendBuf(res, 200, renderIssue(repo, issue), JSON_TYPE);
      if (method === 'PATCH') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
        if (typeof parsed.value.state === 'string') issue.state = parsed.value.state;
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.labels !== undefined) {
          const names = labelsFromBody(parsed.value);
          for (const name of names) if (!repo.labels.has(name)) return void sendError(res, 422, `Validation Failed: label "${name}" does not exist`);
          issue.labels = names;
        }
        issue.json = null;
        return void sendBuf(res, 200, renderIssue(repo, issue), JSON_TYPE);
      }
      return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    }
    if (sub.length === 3 && sub[2] === 'comments') {
      if (issue === undefined) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      if (method === 'GET') {
        return void sendJson(res, 200, issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: repoOwner(repo), id: 1, type: 'User' },
          created_at: FIXED_TIME,
          updated_at: FIXED_TIME,
        })));
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
        const comment = { id: repo.nextCommentId++, body: str(parsed.value.body) };
        issue.comments.push(comment);
        issue.json = null;
        return void sendJson(res, 201, {
          id: comment.id,
          body: comment.body,
          user: { login: repoOwner(repo), id: 1, type: 'User' },
          created_at: FIXED_TIME,
          updated_at: FIXED_TIME,
        });
      }
      return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    }
    return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  }

  if (sub[0] === 'pulls') {
    if (sub.length === 1) {
      if (method === 'GET') {
        const state = queryParam(query, 'state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        const { page } = pageOf(list, query);
        return void sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
        let head = str(parsed.value.head);
        if (head.includes(':')) head = head.slice(head.lastIndexOf(':') + 1);
        const base = str(parsed.value.base) || repo.defaultBranch;
        if (branchTip(repo, head) === null) return void sendError(res, 422, 'Validation Failed: head ref does not exist');
        if (branchTip(repo, base) === null) return void sendError(res, 422, 'Validation Failed: base ref does not exist');
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
            return void sendError(res, 422, 'Validation Failed: a pull request already exists for this branch');
          }
        }
        const pull: PullRec = {
          number: repo.nextNumber++,
          dbId: nextDbId++,
          title: str(parsed.value.title),
          body: str(parsed.value.body),
          state: 'open',
          merged: false,
          headRef: head,
          baseRef: base,
          mergeCommitSha: null,
        };
        repo.pulls.set(pull.number, pull);
        return void sendJson(res, 201, pullJson(repo, pull));
      }
      return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    }
    const number = Number.parseInt(sub[1], 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (sub.length === 2 && method === 'GET') {
      if (pull === undefined) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      return void sendJson(res, 200, pullJson(repo, pull));
    }
    if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
      if (pull === undefined) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      const files = pullFiles(repo, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef));
      return void sendJson(res, 200, files);
    }
    if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return void sendBuf(res, 400, BODY_BAD_JSON, JSON_TYPE);
      const method2 = str(parsed.value.merge_method) || 'squash';
      const result = mergePull(repo, pull, method2 === 'merge' ? 'merge' : 'squash');
      if ('error' in result) return void sendError(res, result.status, result.error);
      return void sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  }

  return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
}

// ---------------------------------------------------------------------------
// GraphQL

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selection: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeName: string; selection: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  selection: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection[]>;
}

function tokenizeGql(source: string): Array<{ t: string; v: string }> {
  const tokens: Array<{ t: string; v: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]=@$!'.includes(ch)) {
      tokens.push({ t: 'punct', v: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ t: 'string', v: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ t: 'number', v: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ t: 'name', v: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function parseGql(source: string): GqlDocument {
  const tokens = tokenizeGql(source);
  let pos = 0;
  const peek = (): { t: string; v: string } | undefined => tokens[pos];
  const next = (): { t: string; v: string } => {
    const token = tokens[pos];
    pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  };
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.v !== value) throw new Error(`expected ${value}`);
  };

  function parseValue(): GqlValue {
    const token = next();
    if (token.v === '$') {
      const name = next();
      return { kind: 'var', name: name.v };
    }
    if (token.t === 'string') return { kind: 'scalar', value: token.v };
    if (token.t === 'number') return { kind: 'scalar', value: Number(token.v) };
    if (token.v === '[') {
      const items: GqlValue[] = [];
      while (peek()?.v !== ']') items.push(parseValue());
      next();
      return { kind: 'list', items };
    }
    if (token.v === '{') {
      const fields = new Map<string, GqlValue>();
      while (peek()?.v !== '}') {
        const key = next();
        expectPunct(':');
        fields.set(key.v, parseValue());
      }
      next();
      return { kind: 'object', fields };
    }
    if (token.t === 'name') {
      if (token.v === 'true') return { kind: 'scalar', value: true };
      if (token.v === 'false') return { kind: 'scalar', value: false };
      if (token.v === 'null') return { kind: 'scalar', value: null };
      return { kind: 'scalar', value: token.v }; // enum
    }
    throw new Error(`unexpected value token ${token.v}`);
  }

  function skipBalanced(open: string, close: string): void {
    expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (token.v === open) depth += 1;
      else if (token.v === close) depth -= 1;
    }
  }

  function parseSelectionSet(): GqlSelection[] {
    expectPunct('{');
    const selections: GqlSelection[] = [];
    while (peek()?.v !== '}') {
      const token = peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.v === '...') {
        next();
        const target = next();
        if (target.v === 'on') {
          const typeName = next().v;
          selections.push({ kind: 'inline', typeName, selection: parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: target.v });
        }
        continue;
      }
      const first = next();
      let alias: string | null = null;
      let name = first.v;
      if (peek()?.v === ':') {
        next();
        alias = name;
        name = next().v;
      }
      const args = new Map<string, GqlValue>();
      if (peek()?.v === '(') {
        next();
        while (peek()?.v !== ')') {
          const key = next();
          expectPunct(':');
          args.set(key.v, parseValue());
        }
        next();
      }
      // directives are skipped
      while (peek()?.v === '@') {
        next();
        next();
        if (peek()?.v === '(') skipBalanced('(', ')');
      }
      let selection: GqlSelection[] | null = null;
      if (peek()?.v === '{') selection = parseSelectionSet();
      selections.push({ kind: 'field', field: { name, alias, args, selection } });
    }
    next();
    return selections;
  }

  const document: GqlDocument = { operations: [], fragments: new Map() };
  while (pos < tokens.length) {
    const token = peek();
    if (token === undefined) break;
    if (token.v === '{') {
      document.operations.push({ type: 'query', selection: parseSelectionSet() });
      continue;
    }
    if (token.v === 'query' || token.v === 'mutation') {
      const type = token.v;
      next();
      if (peek()?.t === 'name') next(); // operation name
      if (peek()?.v === '(') skipBalanced('(', ')'); // variable definitions
      while (peek()?.v === '@') {
        next();
        next();
        if (peek()?.v === '(') skipBalanced('(', ')');
      }
      document.operations.push({ type, selection: parseSelectionSet() });
      continue;
    }
    if (token.v === 'fragment') {
      next();
      const name = next().v;
      next(); // 'on'
      next(); // type name
      document.fragments.set(name, parseSelectionSet());
      continue;
    }
    next(); // schema/type definitions etc. are not expected; skip defensively
  }
  return document;
}

function gqlResolve(value: GqlValue, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'scalar':
      return value.value;
    case 'list':
      return value.items.map((item) => gqlResolve(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = gqlResolve(inner, vars);
      return out;
    }
  }
}

interface GqlObj {
  __type: string;
  [key: string]: unknown;
}

function gqlUser(login: string): GqlObj {
  return { __type: 'User', login };
}
function gqlRepo(repo: Repo): GqlObj {
  return { __type: 'Repository', repo };
}
function gqlIssue(repo: Repo, issue: IssueRec): GqlObj {
  return { __type: 'Issue', repo, issue };
}
function gqlPull(repo: Repo, pull: PullRec): GqlObj {
  return { __type: 'PullRequest', repo, pull };
}
function gqlComment(repo: Repo, issue: IssueRec, comment: { id: number; body: string }): GqlObj {
  return { __type: 'IssueComment', repo, issue, comment };
}

function gqlConnection(items: GqlObj[], args: Map<string, unknown>): GqlObj {
  const after = typeof args.get('after') === 'string' ? Number.parseInt(args.get('after') as string, 10) : NaN;
  const start = Number.isFinite(after) ? after + 1 : 0;
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' ? firstRaw : items.length;
  const slice = items.slice(start, start + first);
  return {
    __type: 'Connection',
    items: slice,
    totalCount: items.length,
    hasNextPage: start + slice.length < items.length,
    endCursor: slice.length > 0 ? String(start + slice.length - 1) : typeof args.get('after') === 'string' ? (args.get('after') as string) : '',
  };
}

const GQL_TYPE_FIELDS: Record<string, { kind: string; fields: string[]; enums: string[] }> = {
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'isArchived', 'isFork', 'description', 'url', 'createdAt', 'updatedAt', 'stargazerCount', 'forkCount', 'issue', 'issues', 'issueOrPullRequest', 'pullRequest', 'pullRequests', 'labels'],
    enums: [],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'repository', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt'], enums: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'repository', 'author', 'url', 'files', 'createdAt', 'updatedAt'],
    enums: [],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'url'], enums: [] },
  SearchType: { kind: 'ENUM', fields: [], enums: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', fields: [], enums: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enums: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enums: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

interface GqlCtx {
  errors: Array<{ message: string }>;
  doc: GqlDocument;
}

function gqlNode(idRaw: string): GqlObj | null {
  const parsed = parseGlobalId(idRaw);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = reposByDbId.get(Number(parsed.parts[0]));
    return repo === undefined ? null : gqlRepo(repo);
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const repo = reposByDbId.get(Number(parsed.parts[0]));
    if (repo === undefined) return null;
    const number = Number(parsed.parts[1]);
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : gqlIssue(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : gqlPull(repo, pull);
  }
  if (parsed.kind === 'User') return gqlUser(parsed.parts[0]);
  return null;
}

function gqlRepoById(idRaw: string): Repo | null {
  const node = gqlNode(idRaw);
  if (node === null || node.__type !== 'Repository') return null;
  return node.repo as Repo;
}

function stateFilter(args: Map<string, unknown>): Set<string> | null {
  const raw = args.get('states');
  if (!Array.isArray(raw)) return null;
  return new Set(raw.map((entry) => String(entry).toLowerCase()));
}

function gqlField(obj: GqlObj, field: string, args: Map<string, unknown>, ctx: GqlCtx): unknown {
  const type = obj.__type;
  const unknown = (): null => {
    ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${type}'` });
    return null;
  };
  switch (type) {
    case 'Query': {
      switch (field) {
        case 'viewer':
          return gqlUser(viewerLogin ?? 'viewer');
        case 'repository': {
          const name = String(args.get('name') ?? '');
          const owner = String(args.get('owner') ?? '');
          const repo = reposByName.get(name);
          if (repo === undefined || !claimRepo(repo, owner)) return null;
          return gqlRepo(repo);
        }
        case 'node':
          return gqlNode(String(args.get('id') ?? ''));
        case 'search':
          return { __type: 'SearchResultItemConnection', items: [], totalCount: 0, hasNextPage: false, endCursor: '' };
        case '__type': {
          const name = String(args.get('name') ?? '');
          const info = GQL_TYPE_FIELDS[name] ?? { kind: 'OBJECT', fields: [], enums: [] };
          return {
            __type: '__Type',
            name,
            kind: info.kind,
            fieldsList: info.fields.map((fieldName) => ({ __type: '__Field', name: fieldName })),
            enumValuesList: info.enums.map((enumName) => ({ __type: '__EnumValue', name: enumName })),
          };
        }
        case '__schema':
          return { __type: '__Schema' };
        case 'rateLimit':
          return { __type: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1 };
        default:
          return unknown();
      }
    }
    case 'Repository': {
      const repo = obj.repo as Repo;
      const owner = repoOwner(repo);
      switch (field) {
        case 'id': return globalId('Repository', repo.dbId);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${owner}/${repo.name}`;
        case 'description': return repo.desc;
        case 'isPrivate': return repo.priv;
        case 'isArchived': return false;
        case 'isFork': return false;
        case 'url': return `/${owner}/${repo.name}`;
        case 'createdAt': return FIXED_TIME;
        case 'updatedAt': return FIXED_TIME;
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'hasIssuesEnabled': return true;
        case 'hasWikiEnabled': return false;
        case 'viewerPermission': return 'ADMIN';
        case 'owner': return gqlUser(owner);
        case 'defaultBranchRef': return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' };
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue === undefined ? null : gqlIssue(repo, issue);
        }
        case 'issues': {
          const filter = stateFilter(args);
          let list = [...repo.issues.values()];
          if (filter !== null) list = list.filter((issue) => filter.has(issue.state));
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction === 'ASC' ? 'asc' : orderBy !== undefined ? 'desc' : 'asc';
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          return gqlConnection(list.map((issue) => gqlIssue(repo, issue)), args);
        }
        case 'issueOrPullRequest': {
          const number = Number(args.get('number'));
          const issue = repo.issues.get(number);
          if (issue !== undefined) return gqlIssue(repo, issue);
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : gqlPull(repo, pull);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull === undefined ? null : gqlPull(repo, pull);
        }
        case 'pullRequests': {
          const filter = stateFilter(args);
          let list = [...repo.pulls.values()];
          if (filter !== null) list = list.filter((pull) => filter.has(pull.merged ? 'merged' : pull.state));
          list.sort((a, b) => a.number - b.number);
          return gqlConnection(list.map((pull) => gqlPull(repo, pull)), args);
        }
        case 'labels': {
          const list = [...repo.labels.values()].map((label) => ({ __type: 'Label', name: label.name, color: label.color }));
          return gqlConnection(list, args);
        }
        default:
          return unknown();
      }
    }
    case 'Issue': {
      const repo = obj.repo as Repo;
      const issue = obj.issue as IssueRec;
      switch (field) {
        case 'id': return globalId('Issue', repo.dbId, issue.number);
        case 'databaseId': return issue.dbId;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'url': return `/${repoOwner(repo)}/${repo.name}/issues/${issue.number}`;
        case 'repository': return gqlRepo(repo);
        case 'author': return gqlUser(repoOwner(repo));
        case 'createdAt': return FIXED_TIME;
        case 'updatedAt': return FIXED_TIME;
        case 'closedAt': return issue.state === 'closed' ? FIXED_TIME : null;
        case 'labels':
          return gqlConnection(issue.labels.map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })), args);
        case 'comments':
          return gqlConnection(issue.comments.map((comment) => gqlComment(repo, issue, comment)), args);
        default:
          return unknown();
      }
    }
    case 'PullRequest': {
      const repo = obj.repo as Repo;
      const pull = obj.pull as PullRec;
      switch (field) {
        case 'id': return globalId('PullRequest', repo.dbId, pull.number);
        case 'databaseId': return pull.dbId;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.merged ? FIXED_TIME : null;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'mergeCommit': return pull.mergeCommitSha !== null ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return branchTip(repo, pull.headRef) ?? ZERO_OID;
        case 'baseRefOid': return branchTip(repo, pull.baseRef) ?? ZERO_OID;
        case 'repository': return gqlRepo(repo);
        case 'author': return gqlUser(repoOwner(repo));
        case 'url': return `/${repoOwner(repo)}/${repo.name}/pulls/${pull.number}`;
        case 'createdAt': return FIXED_TIME;
        case 'updatedAt': return FIXED_TIME;
        case 'files': {
          const files = pullFiles(repo, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef)).map((file) => ({
            __type: 'PullRequestChangedFile',
            path: String(file.filename),
            additions: Number(file.additions),
            deletions: Number(file.deletions),
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return gqlConnection(files, args);
        }
        default:
          return unknown();
      }
    }
    case 'User': {
      switch (field) {
        case 'id': return globalId('User', String(obj.login));
        case 'login': return String(obj.login);
        case 'name': return 'Forge Viewer';
        case 'url': return `/${String(obj.login)}`;
        default: return unknown();
      }
    }
    case 'Ref': {
      switch (field) {
        case 'name': return String(obj.name);
        case 'prefix': return String(obj.prefix ?? 'refs/heads/');
        case 'target': return null;
        default: return unknown();
      }
    }
    case 'Commit': {
      switch (field) {
        case 'oid': return String(obj.oid);
        case 'id': return globalId('Commit', String(obj.oid));
        case 'url': return '';
        default: return unknown();
      }
    }
    case 'Label': {
      switch (field) {
        case 'id': return globalId('Label', String(obj.name));
        case 'name': return String(obj.name);
        case 'color': return String(obj.color ?? 'ededed');
        case 'description': return null;
        default: return unknown();
      }
    }
    case 'IssueComment': {
      const repo = obj.repo as Repo;
      const comment = obj.comment as { id: number; body: string };
      switch (field) {
        case 'id': return globalId('IssueComment', repo.dbId, (obj.issue as IssueRec).number, comment.id);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'bodyText': return comment.body;
        case 'author': return gqlUser(repoOwner(repo));
        case 'createdAt': return FIXED_TIME;
        case 'updatedAt': return FIXED_TIME;
        default: return unknown();
      }
    }
    case 'Connection':
    case 'SearchResultItemConnection': {
      switch (field) {
        case 'nodes': return obj.items;
        case 'edges':
          return (obj.items as GqlObj[]).map((node) => ({ __type: 'Edge', node, cursor: '' }));
        case 'pageInfo':
          return { __type: 'PageInfo', hasNextPage: Boolean(obj.hasNextPage), hasPreviousPage: false, endCursor: String(obj.endCursor ?? ''), startCursor: String(obj.endCursor ?? '') };
        case 'totalCount': return Number(obj.totalCount ?? 0);
        case 'issueCount': return Number(obj.totalCount ?? 0);
        default: return unknown();
      }
    }
    case 'Edge': {
      switch (field) {
        case 'node': return obj.node;
        case 'cursor': return String(obj.cursor ?? '');
        default: return unknown();
      }
    }
    case 'PageInfo': {
      switch (field) {
        case 'hasNextPage': return Boolean(obj.hasNextPage);
        case 'hasPreviousPage': return false;
        case 'endCursor': return String(obj.endCursor ?? '');
        case 'startCursor': return String(obj.startCursor ?? '');
        default: return unknown();
      }
    }
    case '__Type': {
      switch (field) {
        case 'name': return String(obj.name);
        case 'kind': return String(obj.kind);
        case 'fields': return obj.fieldsList;
        case 'enumValues': return obj.enumValuesList;
        case 'description': return null;
        default: return unknown();
      }
    }
    case '__Field': {
      if (field === 'name') return String(obj.name);
      return unknown();
    }
    case '__EnumValue': {
      if (field === 'name') return String(obj.name);
      return unknown();
    }
    case 'RateLimit': {
      switch (field) {
        case 'limit': return 5000;
        case 'cost': return 1;
        case 'remaining': return 4999;
        case 'used': return 1;
        case 'resetAt': return FIXED_TIME;
        default: return unknown();
      }
    }
    case 'Mutation': {
      const input = (args.get('input') as Record<string, unknown> | undefined) ?? {};
      const arg = (key: string): unknown => input[key] ?? args.get(key);
      switch (field) {
        case 'createIssue': {
          const repo = gqlRepoById(String(arg('repositoryId') ?? ''));
          if (repo === null) { ctx.errors.push({ message: 'Repository not found' }); return { __type: 'CreateIssuePayload', issue: null }; }
          const issue = createIssueRec(repo, String(arg('title') ?? ''), String(arg('body') ?? ''), []);
          return { __type: 'CreateIssuePayload', issue: gqlIssue(repo, issue), clientMutationId: null };
        }
        case 'closeIssue': {
          const node = gqlNode(String(arg('issueId') ?? ''));
          if (node === null || node.__type !== 'Issue') { ctx.errors.push({ message: 'Issue not found' }); return { __type: 'CloseIssuePayload', issue: null }; }
          (node.issue as IssueRec).state = 'closed';
          (node.issue as IssueRec).json = null;
          return { __type: 'CloseIssuePayload', issue: node, clientMutationId: null };
        }
        case 'reopenIssue': {
          const node = gqlNode(String(arg('issueId') ?? ''));
          if (node === null || node.__type !== 'Issue') { ctx.errors.push({ message: 'Issue not found' }); return { __type: 'ReopenIssuePayload', issue: null }; }
          (node.issue as IssueRec).state = 'open';
          (node.issue as IssueRec).json = null;
          return { __type: 'ReopenIssuePayload', issue: node, clientMutationId: null };
        }
        case 'createPullRequest': {
          const repo = gqlRepoById(String(arg('repositoryId') ?? ''));
          if (repo === null) { ctx.errors.push({ message: 'Repository not found' }); return { __type: 'CreatePullRequestPayload', pullRequest: null }; }
          const pull: PullRec = {
            number: repo.nextNumber++,
            dbId: nextDbId++,
            title: String(arg('title') ?? ''),
            body: String(arg('body') ?? ''),
            state: 'open',
            merged: false,
            headRef: String(arg('headRefName') ?? ''),
            baseRef: String(arg('baseRefName') ?? repo.defaultBranch),
            mergeCommitSha: null,
          };
          repo.pulls.set(pull.number, pull);
          return { __type: 'CreatePullRequestPayload', pullRequest: gqlPull(repo, pull), clientMutationId: null };
        }
        case 'mergePullRequest': {
          const node = gqlNode(String(arg('pullRequestId') ?? ''));
          if (node === null || node.__type !== 'PullRequest') { ctx.errors.push({ message: 'Pull request not found' }); return { __type: 'MergePullRequestPayload', pullRequest: null }; }
          const method = String(arg('mergeMethod') ?? 'SQUASH');
          const result = mergePull(node.repo as Repo, node.pull as PullRec, method === 'MERGE' ? 'merge' : 'squash');
          if ('error' in result) ctx.errors.push({ message: result.error });
          return { __type: 'MergePullRequestPayload', pullRequest: node, clientMutationId: null };
        }
        case 'addComment': {
          const node = gqlNode(String(arg('subjectId') ?? ''));
          if (node === null || node.__type !== 'Issue') { ctx.errors.push({ message: 'Subject not found' }); return { __type: 'AddCommentPayload', commentEdge: null }; }
          const repo = node.repo as Repo;
          const issue = node.issue as IssueRec;
          const comment = { id: repo.nextCommentId++, body: String(arg('body') ?? '') };
          issue.comments.push(comment);
          issue.json = null;
          return {
            __type: 'AddCommentPayload',
            commentEdge: { __type: 'Edge', node: gqlComment(repo, issue, comment), cursor: '' },
            subject: node,
            clientMutationId: null,
          };
        }
        case 'createRepository': {
          const name = String(arg('name') ?? '');
          if (name === '' || reposByName.has(name)) { ctx.errors.push({ message: 'Repository already exists' }); return { __type: 'CreateRepositoryPayload', repository: null }; }
          const repo = createRepoRec(name, String(arg('visibility') ?? 'PUBLIC') === 'PRIVATE', '');
          return { __type: 'CreateRepositoryPayload', repository: gqlRepo(repo), clientMutationId: null };
        }
        default:
          return unknown();
      }
    }
    default: {
      // payload objects and other leaves: fields are stored directly
      if (field in obj) return obj[field];
      if (field === 'clientMutationId') return null;
      return unknown();
    }
  }
}

function gqlExecuteSelection(obj: unknown, selections: GqlSelection[], vars: Record<string, unknown>, ctx: GqlCtx): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map((item) => gqlExecuteSelection(item, selections, vars, ctx));
  if (typeof obj !== 'object') return obj;
  const record = obj as GqlObj;
  const out: Record<string, unknown> = {};
  const walk = (sels: GqlSelection[]): void => {
    for (const sel of sels) {
      if (sel.kind === 'inline') {
        walk(sel.selection);
        continue;
      }
      if (sel.kind === 'spread') {
        const fragment = ctx.doc.fragments.get(sel.name);
        if (fragment !== undefined) walk(fragment);
        continue;
      }
      const field = sel.field;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = record.__type;
        continue;
      }
      const args = new Map<string, unknown>();
      for (const [argName, argValue] of field.args) args.set(argName, gqlResolve(argValue, vars));
      const value = gqlField(record, field.name, args, ctx);
      out[key] = field.selection !== null && field.selection !== undefined
        ? gqlExecuteSelection(value, field.selection, vars, ctx)
        : value;
    }
  };
  walk(selections);
  return out;
}

function gqlRunOne(payload: Record<string, unknown>): Record<string, unknown> {
  const query = String(payload.query ?? '');
  const vars = (payload.variables as Record<string, unknown> | undefined) ?? {};
  let doc: GqlDocument;
  try {
    doc = parseGql(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation found' }] };
  const ctx: GqlCtx = { errors: [], doc };
  const root: GqlObj = operation.type === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = gqlExecuteSelection(root, operation.selection, vars, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

function handleGraphql(res: ServerResponse, raw: Buffer): void {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  if (Array.isArray(parsedJson)) {
    const results = parsedJson.map((entry) =>
      gqlRunOne(typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}),
    );
    sendJson(res, 200, results);
    return;
  }
  if (typeof parsedJson !== 'object' || parsedJson === null) {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  sendJson(res, 200, gqlRunOne(parsedJson as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC over HTTP)

const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpToolDef(name: string, description: string, properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: true, required } };
}

const MCP_TOOLS_JSON = JSON.stringify([
  mcpToolDef('create_repo', 'Create a new repository for the authenticated user.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  mcpToolDef('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
  }, ['owner', 'repo']),
  mcpToolDef('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  mcpToolDef('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed or all.' },
  }, ['owner', 'repo']),
  mcpToolDef('create_pull_request', 'Create a pull request in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Pull request title.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
    body: { type: 'string', description: 'Pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  mcpToolDef('merge_pull_request', 'Merge a pull request by number.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    pull_number: { type: 'number', description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);
const MCP_TOOLS: Array<Record<string, unknown>> = JSON.parse(MCP_TOOLS_JSON) as Array<Record<string, unknown>>;

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpToolSuccess(structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function mcpRepoArg(args: Record<string, unknown>): Repo | null {
  const repo = reposByName.get(String(args.repo ?? ''));
  if (repo === undefined) return null;
  if (!claimRepo(repo, String(args.owner ?? ''))) return null;
  return repo;
}

function mcpCallTool(name: string, args: Record<string, unknown>, id: unknown): Record<string, unknown> {
  const requiredByTool: Record<string, string[]> = {
    create_repo: ['name'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  const required = requiredByTool[name];
  if (required === undefined) return mcpError(id, -32602, `Unknown tool: ${name}`);
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return mcpError(id, -32602, `Missing required argument: ${key}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = reposByName.get(repoName);
      if (existing !== undefined) return mcpResult(id, mcpToolSuccess(repoJson(existing)));
      const repo = createRepoRec(repoName, args.private === true, String(args.description ?? ''));
      return mcpResult(id, mcpToolSuccess(repoJson(repo)));
    }
    case 'get_repo': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpResult(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      return mcpResult(id, mcpToolSuccess(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpResult(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      const labels = Array.isArray(args.labels) ? args.labels.map((entry) => String(entry)) : [];
      const created = createIssueChecked(repo, String(args.title), String(args.body ?? ''), labels);
      if (typeof created === 'string') return mcpResult(id, { content: [{ type: 'text', text: created }], isError: true });
      return mcpResult(id, mcpToolSuccess(issueJsonValue(repo, created)));
    }
    case 'list_issues': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpResult(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      const state = String(args.state ?? 'open');
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return mcpResult(id, mcpToolSuccess(list.map((issue) => issueJsonValue(repo, issue))));
    }
    case 'create_pull_request': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpResult(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      let head = String(args.head);
      if (head.includes(':')) head = head.slice(head.lastIndexOf(':') + 1);
      const base = String(args.base);
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) {
        return mcpResult(id, { content: [{ type: 'text', text: 'Validation Failed: head or base branch does not exist' }], isError: true });
      }
      const pull: PullRec = {
        number: repo.nextNumber++,
        dbId: nextDbId++,
        title: String(args.title),
        body: String(args.body ?? ''),
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        mergeCommitSha: null,
      };
      repo.pulls.set(pull.number, pull);
      return mcpResult(id, mcpToolSuccess(pullJson(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpResult(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return mcpResult(id, { content: [{ type: 'text', text: 'Pull request not found' }], isError: true });
      const result = mergePull(repo, pull, 'squash');
      if ('error' in result) return mcpResult(id, { content: [{ type: 'text', text: result.error }], isError: true });
      return mcpResult(id, mcpToolSuccess({ sha: result.sha, merged: true, message: 'Pull Request successfully merged', number: pull.number, state: pull.state }));
    }
    default:
      return mcpError(id, -32602, `Unknown tool: ${name}`);
  }
}

function mcpHandleOne(message: Record<string, unknown>): Record<string, unknown> | null {
  const method = String(message.method ?? '');
  const id = message.id;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'server/discover':
      return mcpResult(id, {
        supportedVersions: MCP_PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '2.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '2.0.0' } },
      });
    case 'initialize': {
      const params = (message.params as Record<string, unknown> | undefined) ?? {};
      const requested = String(params.protocolVersion ?? MCP_PROTOCOL_VERSIONS[0]);
      return mcpResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '2.0.0' },
      });
    }
    case 'ping':
      return mcpResult(id, {});
    case 'tools/list':
      return mcpResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const params = (message.params as Record<string, unknown> | undefined) ?? {};
      const toolName = String(params.name ?? '');
      const toolArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};
      return mcpCallTool(toolName, toolArgs, id);
    }
    default:
      if (isNotification) return null;
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  if ((req.method ?? 'POST') !== 'POST') {
    sendJson(res, 200, { name: 'forge', version: '2.0.0', protocolVersions: MCP_PROTOCOL_VERSIONS });
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsedJson)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsedJson) {
      if (typeof entry !== 'object' || entry === null) continue;
      const response = mcpHandleOne(entry as Record<string, unknown>);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'content-type': JSON_TYPE, 'x-github-request-id': `f2-${++requestSeq}` });
      res.end();
      return;
    }
    sendJson(res, 200, responses);
    return;
  }
  if (typeof parsedJson !== 'object' || parsedJson === null) {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const message = parsedJson as Record<string, unknown>;
  const response = mcpHandleOne(message);
  if (response === null) {
    res.writeHead(202, { 'content-type': JSON_TYPE, 'x-github-request-id': `f2-${++requestSeq}` });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// ---------------------------------------------------------------------------
// HTTP router + harness lifecycle

function gitRepoFromPath(owner: string, nameWithSuffix: string): Repo | null {
  const name = nameWithSuffix.endsWith('.git') ? nameWithSuffix.slice(0, -4) : nameWithSuffix;
  const repo = reposByName.get(name);
  if (repo === undefined) return null;
  if (!claimRepo(repo, owner)) return null;
  return repo;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const { segments, query } = splitTarget(url);
  const method = req.method ?? 'GET';

  if (segments.length === 1 && segments[0] === 'healthz') {
    sendBuf(res, 200, BODY_HEALTH, JSON_TYPE);
    return;
  }

  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || authorization.trim() === '') {
    sendBuf(res, 401, BODY_UNAUTHORIZED, JSON_TYPE);
    return;
  }

  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  // git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[2] === 'info' && segments[1].endsWith('.git')) {
    const repo = gitRepoFromPath(segments[0], segments[1]);
    if (repo === null) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    return void handleInfoRefs(req, res, repo, query);
  }
  if (segments.length === 2 && segments[1].endsWith('.git') && (method === 'POST')) {
    // not a real route shape; fall through to 404
  }
  if (segments.length === 2 && method === 'POST' && (segments[1] === 'git-upload-pack' || segments[1] === 'git-receive-pack')) {
    return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
  }
  if (segments.length === 3 && segments[0] !== 'api' && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
    const repo = gitRepoFromPath(segments[0], segments[1]);
    if (repo === null) return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    if (segments[2] === 'git-upload-pack') return void handleUploadPack(res, repo, raw);
    return void handleReceivePack(res, repo, raw);
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    return void handleRest(req, res, segments, query, raw);
  }
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
    return void handleGraphql(res, raw);
  }
  if (segments[0] === 'mcp') {
    return void handleMcp(req, res, raw);
  }
  return void sendBuf(res, 404, BODY_NOT_FOUND, JSON_TYPE);
}

function makeServer(): Server {
  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      try {
        if (!res.headersSent) sendBuf(res, 500, BODY_INTERNAL, JSON_TYPE);
        else res.end();
      } catch {
        /* connection already gone */
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  return server;
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const server = makeServer();
  if (envUrl === undefined || envUrl === '') {
    const port = Number.parseInt(process.env.PORT ?? '8734', 10);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`forge v2 listening on 127.0.0.1:${port}`);
    return;
  }
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no address'));
      else resolve(address.port);
    });
  });
  await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: boundPort }),
  });
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) break;
    try {
      const response = await fetch(`${envUrl}/done`);
      const payload = (await response.json()) as { done?: boolean };
      if (payload.done === true) break;
    } catch {
      /* the harness may not be up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
