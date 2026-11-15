// Git engine: object store, packfiles, and smart HTTP (upload-pack v2/v0, receive-pack v0).
// Node 22 stdlib only. No git binary, no disk I/O, everything in memory.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType, Repo, Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

const AGENT = 'makefun-git-forge/1.0';
const PKT_LINE_MAX = 65520;
const MAX_BODY_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// object helpers
// ---------------------------------------------------------------------------------------------

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; author: string } {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  for (const line of headerText.split('\n')) {
    if (!line || line.startsWith(' ')) continue; // continuation of a previous header
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
  }
  return { tree, parents, message, author };
}

export function makeCommit(
  repo: Repo,
  opts: { tree: string; parents: string[]; message: string; author: string },
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const who = `${opts.author} ${timestamp} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
  return putObject(repo, 'commit', data);
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(
  a: { mode: string; name: string },
  b: { mode: string; name: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function makeTree(repo: Repo, entries: { mode: string; name: string; sha: string }[]): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function parseTagTarget(data: Buffer): string {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

/** Follow annotated tags to the object they ultimately point at. */
function peelToNonTag(repo: Repo, oid: string): string {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    const target = parseTagTarget(obj.data);
    if (!target) return current;
    current = target;
  }
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const anc = peelToNonTag(repo, ancestor);
  let desc = peelToNonTag(repo, descendant);
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Closure walk: commits -> tree + parents, tags -> target, trees -> entries (gitlinks skipped). */
function walkClosure(
  repo: Repo,
  roots: Iterable<string>,
  visit: (oid: string, obj: GitObject) => void,
  stopParentsOf?: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    visit(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (!stopParentsOf || !stopParentsOf.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) stack.push(target);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.sha);
      }
    }
  }
}

export function reachableObjects(
  repo: Repo,
  tips: Iterable<string>,
  exclude?: Set<string>,
): Map<string, GitObject> {
  const excluded = new Set<string>();
  if (exclude && exclude.size) {
    walkClosure(repo, exclude, (oid) => {
      excluded.add(oid);
    });
  }
  const out = new Map<string, GitObject>();
  walkClosure(repo, tips, (oid, obj) => {
    if (excluded.has(oid)) return;
    if (!out.has(oid)) out.set(oid, obj);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
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

export function encodePack(objects: Map<string, GitObject>): Buffer {
  const list = [...objects.values()];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
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

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
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

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

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
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
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
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

export function decodePack(buf: Buffer, repo: Repo): Map<string, GitObject> {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    try {
      let type: ObjType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        let base: { type: ObjType; data: Buffer } | undefined;
        const baseEntry = resolvedByOid.get(wanted);
        if (baseEntry) {
          base = resolve(baseEntry);
        } else {
          // The base may be a pack entry that has not been resolved yet: resolve
          // every other entry until it appears (or the repo holds it, thin pack).
          for (const candidate of raw) {
            if (candidate === entry || candidate.resolved) continue;
            try {
              resolve(candidate);
            } catch {
              // A candidate that cannot resolve yet is not the base; keep going.
              // The final resolve below throws if the base is truly missing.
              if (resolvedByOid.has(wanted)) break;
            }
            if (resolvedByOid.has(wanted)) break;
          }
          const found = resolvedByOid.get(wanted);
          if (found) base = resolve(found);
          else base = repo.objects.get(wanted);
          if (!base) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repo`);
        }
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        type = CODE_TYPE[entry.typeCode];
        data = entry.data;
      }
      const oid = hashObject(type, data);
      entry.resolved = data;
      entry.resolvedType = type;
      entry.oid = oid;
      resolvedByOid.set(oid, entry);
      return { type, data, oid };
    } finally {
      resolving.delete(entry.offset);
    }
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function parsePktLineAt(buf: Buffer, offset: number): { pkt: Pkt; next: number } {
  if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
  const header = buf.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  const length = Number.parseInt(header, 16);
  if (length === 0) return { pkt: { kind: 'flush' }, next: offset + 4 };
  if (length === 1) return { pkt: { kind: 'delim' }, next: offset + 4 };
  if (length === 2) return { pkt: { kind: 'response-end' }, next: offset + 4 };
  if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
  if (offset + length > buf.length) throw new Error('truncated pkt-line');
  return { pkt: { kind: 'data', payload: buf.subarray(offset + 4, offset + length) }, next: offset + length };
}

/** Decode pkt-lines until the first flush; returns the data lines and the offset past the flush. */
function parsePktLinesUntilFlush(buf: Buffer): { lines: string[]; restOffset: number } {
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    const { pkt, next } = parsePktLineAt(buf, offset);
    offset = next;
    if (pkt.kind === 'flush') return { lines, restOffset: offset };
    if (pkt.kind === 'data') lines.push(pkt.payload.toString('utf8'));
    // delim / response-end: skipped
  }
}

function parseAllPktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { pkt, next } = parsePktLineAt(buf, offset);
    offset = next;
    packets.push(pkt);
  }
  return packets;
}

function pktLinesToStrings(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const pkt of packets) if (pkt.kind === 'data') lines.push(pkt.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// smart HTTP
// ---------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        fail(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', fail);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? ZERO_OID;
}

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/${repo.default_branch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs thin-pack ofs-delta symref=HEAD:refs/heads/${repo.default_branch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag' && ref.name.startsWith('refs/tags/')) {
        const peeled = peelToNonTag(repo, ref.oid);
        if (peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildV2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function buildLsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const wantHead = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (wantHead) {
    if (head === ZERO_OID) {
      if (args.unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
      else parts.push(pktLine(`${ZERO_OID} HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    } else if (args.symrefs) {
      parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    } else {
      parts.push(pktLine(`${head} HEAD\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (args.prefixes.length && !args.prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (args.peel && obj && obj.type === 'tag') {
      const peeled = peelToNonTag(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out what a fetch sends. `haves` are commits the client already holds in full, except
 * the commits in `oldShallow`, whose parents the client does NOT hold. `depth` bounds the
 * generations taken from the wants (1 = tips only); with `deepenRelative` it is added to the
 * client's current depth, which is the generation of its shallow boundary plus one.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
  options: { deepenRelative?: boolean; includeTag?: boolean } = {},
): FetchPlan {
  const oldShallowSet = new Set(oldShallow);
  const held = new Set<string>();
  if (haves.length) {
    walkClosure(repo, haves, (oid) => {
      held.add(oid);
    }, oldShallowSet);
  }

  // Generations of every commit reachable from the wants (unbounded BFS).
  const generations = new Map<string, number>(); // oid -> generation
  const includedTags = new Set<string>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      includedTags.add(want);
      const target = peelToNonTag(repo, want);
      if (repo.objects.get(target)?.type === 'commit') queue.push({ oid: target, gen: 0 });
      else if (target !== want && repo.objects.has(target)) includedTags.add(target);
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    } else {
      // A want naming a tree/blob directly: include it as a lone object.
      includedTags.add(want);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, gen } = queue[head];
    if (generations.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    generations.set(oid, gen);
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  let effectiveDepth = depth;
  if (depth !== undefined && options.deepenRelative) {
    let current = 0;
    for (const oid of oldShallow) {
      const gen = generations.get(oid);
      if (gen !== undefined) current = Math.max(current, gen + 1);
    }
    effectiveDepth = current + depth;
  }
  const includedCommits = new Map<string, number>();
  for (const [oid, gen] of generations) {
    if (effectiveDepth === undefined || gen < effectiveDepth) includedCommits.set(oid, gen);
  }

  // include-tag: a tag pointing at an included commit travels with it.
  if (options.includeTag) {
    for (const [name, oid] of repo.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      if (repo.objects.get(oid)?.type !== 'tag') continue;
      if (includedCommits.has(peelToNonTag(repo, oid))) includedTags.add(oid);
    }
  }

  // Every object reachable from the included commits and tags — trees and blobs
  // only. Parents are NOT followed here: the depth limit already decided which
  // commits are included, and following parents would undo it.
  const included = new Set<string>();
  {
    const stack = [...includedCommits.keys(), ...includedTags];
    while (stack.length) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      included.add(oid);
      if (obj.type === 'commit') {
        stack.push(parseCommit(obj.data).tree);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          stack.push(entry.sha);
        }
      }
    }
  }

  const objects = new Map<string, GitObject>();
  for (const oid of included) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.set(oid, obj);
  }

  // New shallow boundary: included commits with a parent that was not included.
  const shallow: string[] = [];
  for (const [oid] of includedCommits) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length && parents.some((p) => !includedCommits.has(p))) shallow.push(oid);
  }
  const shallowSet = new Set(shallow);
  const unshallow: string[] = [];
  for (const oid of oldShallow) {
    if (includedCommits.has(oid) && !shallowSet.has(oid)) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleV2Fetch(
  repo: Repo,
  lines: string[],
): Buffer {
  let wants: string[] = [];
  let haves: string[] = [];
  let shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let deepenRelative = false;
  let includeTag = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line === 'done') done = true;
    else if (line === 'deepen-relative') deepenRelative = true;
    else if (line === 'include-tag') includeTag = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, ignored
  }
  wants = [...new Set(wants)];
  // Protocol v2: when the client sends "done", the acknowledgments section MUST
  // be omitted from the response (it only exists for multi-round negotiation on
  // stateful transports). Without "done", answer acknowledgments alone.
  if (!done) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    const knownHave = haves.find((oid) => repo.objects.has(oid));
    if (knownHave) parts.push(pktLine(`ACK ${knownHave}\n`));
    else parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth, { deepenRelative, includeTag });
  const pack = encodePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

function handleV0Fetch(repo: Repo, lines: string[]): Buffer {
  let wants: string[] = [];
  let haves: string[] = [];
  let shallow: string[] = [];
  let depth: number | undefined;
  let includeTag = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const tokens = line.slice(5).trim().split(/\s+/);
      if (tokens[0]) wants.push(tokens[0]);
      // v0 carries fetch options as capabilities on the first want line.
      if (tokens.slice(1).includes('include-tag')) includeTag = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // done, deepen-since, deepen-not: accepted, ignored
  }
  wants = [...new Set(wants)];
  const plan = planFetch(repo, wants, haves, shallow, depth, { includeTag });
  const pack = encodePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const knownHave = haves.find((oid) => repo.objects.has(oid));
  if (knownHave) parts.push(pktLine(`ACK ${knownHave}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, restOffset } = parsePktLinesUntilFlush(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    let commandText = line;
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        commandText = line.slice(0, nul);
        const caps = line.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideband = true;
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(commandText);
    if (!match) throw new Error(`malformed receive-pack command ${JSON.stringify(commandText.slice(0, 80))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (!commands.length) throw new Error('receive-pack sent no commands');

  const packBytes = body.subarray(restOffset);
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (!packBytes.length) {
      unpackOk = false;
      unpackDetail = 'missing pack';
    } else {
      try {
        const decoded = decodePack(packBytes, repo);
        for (const [sha, obj] of decoded) {
          if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = String(err instanceof Error ? err.message : err)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 200);
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail}`);
  let moved = false;
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    if (!cmd.ref.startsWith('refs/')) {
      reportLines.push(`ng ${cmd.ref} invalid ref`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) reportLines.push(`ng ${cmd.ref} no such ref`);
      else if (current !== cmd.oldOid) reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      else {
        repo.refs.delete(cmd.ref);
        moved = true;
        reportLines.push(`ok ${cmd.ref}`);
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) reportLines.push(`ng ${cmd.ref} already exists`);
      else if (!repo.objects.has(cmd.newOid)) reportLines.push(`ng ${cmd.ref} missing object`);
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        moved = true;
        reportLines.push(`ok ${cmd.ref}`);
      }
    } else {
      // update
      if (current === undefined) reportLines.push(`ng ${cmd.ref} no such ref`);
      else if (current !== cmd.oldOid) reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      else if (cmd.oldOid === cmd.newOid) reportLines.push(`ok ${cmd.ref}`);
      else if (!repo.objects.has(cmd.newOid)) reportLines.push(`ng ${cmd.ref} missing object`);
      else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        moved = true;
        reportLines.push(`ok ${cmd.ref}`);
      }
    }
  }
  if (moved) repo.updated_at = new Date().toISOString();

  const reportParts: Buffer[] = reportLines.map((line) => pktLine(`${line}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return report;
}

function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  const packets = parseAllPktLines(body);
  const lines = pktLinesToStrings(packets);
  if (!isV2) return handleV0Fetch(repo, lines);
  // v2: first line is the command; lines up to the delim are its arguments.
  // NB: `lines` holds data packets only, so count data packets before the delim
  // rather than indexing `lines` by the delim's position in `packets`.
  let dataBeforeDelim = 0;
  for (const p of packets) {
    if (p.kind === 'delim') break;
    if (p.kind === 'data') dataBeforeDelim += 1;
  }
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const afterDelim = lines.slice(dataBeforeDelim);
  if (commandLine === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const raw of afterDelim) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return buildLsRefsResponse(repo, args);
  }
  if (commandLine === 'command=fetch') {
    return handleV2Fetch(repo, afterDelim);
  }
  throw new Error(`unknown protocol v2 command ${JSON.stringify(commandLine.slice(0, 60))}`);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname: string;
  let searchParams: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch {
    return false;
  }
  const match = GIT_ROUTE.exec(pathname);
  if (!match) return false;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return false;

  try {
    // The suite's git client sends Authorization: Bearer <MAKEFUN_SHOP_TOKEN> on
    // every git request; require it when the token is configured.
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expectedToken) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${expectedToken}`) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return true;
      }
    }

    let owner: string;
    let repoName: string;
    try {
      owner = decodeURIComponent(match[1]);
      repoName = decodeURIComponent(match[2]);
    } catch {
      sendText(res, 400, 'bad request\n');
      return true;
    }
    // A repository belongs to the login the token names: any other owner is 404.
    const repo = store.getRepo(owner, repoName);
    const route = match[3];

    if (method === 'GET' && route === 'info/refs') {
      const service = searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendText(res, 404, 'Not Found\n');
        return true;
      }
      if (!repo) {
        sendText(res, 404, 'Not Found\n');
        return true;
      }
      const isV2 =
        service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', buildV2Advertisement());
      } else {
        sendBuffer(
          res,
          200,
          `application/x-${service}-advertisement`,
          buildV0Advertisement(repo, service),
        );
      }
      return true;
    }

    if (method === 'POST' && (route === 'git-upload-pack' || route === 'git-receive-pack')) {
      if (!repo) {
        sendText(res, 404, 'Not Found\n');
        return true;
      }
      const body = await readBody(req);
      if (route === 'git-receive-pack') {
        const out = handleReceivePack(repo, body);
        sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
      } else {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const out = handleUploadPack(repo, body, isV2);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
      }
      return true;
    }

    return false;
  } catch (err) {
    // Never crash on malformed input: answer a protocol-level error and stay up.
    if (!res.headersSent) {
      try {
        sendText(res, 400, 'bad request\n');
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
    return true;
  }
}
