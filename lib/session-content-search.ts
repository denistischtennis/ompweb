import { createReadStream, promises as fs } from "fs";
import { createInterface } from "readline";
import { listAllSessions } from "./session-reader";
import {
  compileSearchQuery,
  CONTENT_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
  type SearchField,
} from "./session-search";
export const MAX_CONTENT_CACHE_ENTRIES = 200;

interface ContentCacheEntry {
  version: string;
  field: Promise<SearchField>;
}

declare global {
  var __ompSessionContentSearchCache: Map<string, ContentCacheEntry> | undefined;
}

const PARSE_CONCURRENCY = 4;

interface SearchEntry {
  id: string;
  parentId: string | null;
  type: string;
  texts?: string[];
  firstKeptEntryId?: string;
}

const PROJECTED_LINE_MAX = 64 * 1024;
const PROJECTED_HEAD_MAX = 4096;
const JSON_STRING = "((?:\\\\.|[^\"\\\\])*)";
const TYPE_RE = new RegExp(`\"type\"\\s*:\\s*\"${JSON_STRING}\"`);
const ID_RE = new RegExp(`\"id\"\\s*:\\s*\"${JSON_STRING}\"`);
const PARENT_RE = new RegExp(`\"parentId\"\\s*:\\s*(null|\"${JSON_STRING}\")`);
const ROLE_RE = new RegExp(`\"role\"\\s*:\\s*\"${JSON_STRING}\"`);

function decoded(match: RegExpExecArray | null, group = 1): string | null {
  if (!match?.[group]) return null;
  try {
    return JSON.parse(`"${match[group]}"`) as string;
  } catch {
    return null;
  }
}

/** Parse large excluded records by their canonical metadata prefix, not their payload. */
function parseSearchRecord(line: string, legacy: boolean): Record<string, unknown> {
  if (line.length <= PROJECTED_LINE_MAX) return JSON.parse(line) as Record<string, unknown>;
  const head = line.slice(0, PROJECTED_HEAD_MAX);
  const type = decoded(TYPE_RE.exec(head));
  if (!type || type === "session" || type === "compaction") return JSON.parse(line) as Record<string, unknown>;
  const role = type === "message" ? decoded(ROLE_RE.exec(head)) : null;
  if (type === "message" && (!role || role === "user" || role === "assistant")) {
    return JSON.parse(line) as Record<string, unknown>;
  }
  if (legacy) return { type, ...(role ? { message: { role } } : {}) };
  const id = decoded(ID_RE.exec(head));
  const parentMatch = PARENT_RE.exec(head);
  const parentId = parentMatch?.[1] === "null" ? null : decoded(parentMatch, 2);
  if (!id || !parentMatch || (parentMatch[1] !== "null" && parentId === null)) {
    return JSON.parse(line) as Record<string, unknown>;
  }
  return { type, id, parentId, ...(role ? { message: { role } } : {}) };
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

function activeText(entries: SearchEntry[]): string {
  const byId = new Map<string, SearchEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const path: SearchEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  const compactionIdx = path.findLastIndex((entry) => entry.type === "compaction");
  const firstKeptEntryId = compactionIdx >= 0 ? path[compactionIdx].firstKeptEntryId : undefined;
  const firstKeptIdx = compactionIdx >= 0
    ? path.findIndex((entry, index) => index < compactionIdx && entry.id === firstKeptEntryId)
    : -1;
  const parts: string[] = [];
  for (let index = 0; index < path.length; index++) {
    if (compactionIdx >= 0 && (index === compactionIdx || index < (firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx))) continue;
    for (const text of path[index].texts ?? []) parts.push(text);
  }
  return parts.join("\n");
}

/** Active conversation's user and assistant text only: tool output and thinking would drown real matches. */
async function extractTranscriptText(filePath: string): Promise<string> {
  const entries: SearchEntry[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let legacy = false;
  try {
    for await (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = parseSearchRecord(line, legacy);
      } catch {
        continue;
      }
      if (record.type === "title") continue;
      if (record.type === "session") {
        legacy = record.version === 1;
        continue;
      }
      if (typeof record.type !== "string") continue;
      const id = legacy ? `legacy:${entries.length}` : record.id;
      const parentId = legacy ? entries.at(-1)?.id ?? null : record.parentId;
      if (typeof id !== "string" || (parentId !== null && typeof parentId !== "string")) continue;
      const message = record.message && typeof record.message === "object"
        ? record.message as { role?: unknown; content?: unknown }
        : null;
      const role = typeof message?.role === "string" ? message.role : undefined;
      let firstKeptEntryId = typeof record.firstKeptEntryId === "string" ? record.firstKeptEntryId : undefined;
      if (legacy && record.type === "compaction" && typeof record.firstKeptEntryIndex === "number") {
        firstKeptEntryId = entries[record.firstKeptEntryIndex - 1]?.id;
      }
      entries.push({
        id,
        parentId,
        type: record.type,
        ...(role === "user" || role === "assistant" ? { texts: textBlocks(message?.content) } : {}),
        ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return activeText(entries);
}

function touchCacheEntry(cache: Map<string, ContentCacheEntry>, key: string, entry: ContentCacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CONTENT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

// shortcut: holds every session's extracted text in memory (~1% of file size) and
// re-reads a whole file when it changes; move to an on-disk index if installs outgrow that.
export async function transcriptField(filePath: string, cache: Map<string, ContentCacheEntry>): Promise<SearchField | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache.delete(filePath);
    return null;
  }
  const version = `${stat.size}:${stat.mtimeMs}`;
  let entry = cache.get(filePath);
  if (entry?.version === version) {
    touchCacheEntry(cache, filePath, entry);
    return entry.field.catch(() => null);
  }
  entry = { version, field: extractTranscriptText(filePath).then((text) => searchField(text, CONTENT_WEIGHT)) };
  touchCacheEntry(cache, filePath, entry);
  // A failed read must not stay cached.
  entry.field.catch(() => { if (cache.get(filePath) === entry) cache.delete(filePath); });
  return entry.field.catch(() => null);
}

/**
 * Yields matching session ids with their scores (titles outrank transcript
 * matches), one batch per group of scanned files, so callers can stream hits.
 * Every group yields, even with no hits: a caller stopping the iteration
 * (`return()` waits for the pending `next()`) then stops after that group.
 */
export async function* searchSessions(rawQuery: string): AsyncGenerator<Record<string, number>> {
  const query = compileSearchQuery(rawQuery);
  if (!query) return;
  const sessions = await listAllSessions();
  const cache = (globalThis.__ompSessionContentSearchCache ??= new Map());
  const listed = new Set(sessions.map((s) => s.path));
  for (const path of cache.keys()) if (!listed.has(path)) cache.delete(path);

  for (let i = 0; i < sessions.length; i += PARSE_CONCURRENCY) {
    const scores: Record<string, number> = {};
    await Promise.all(sessions.slice(i, i + PARSE_CONCURRENCY).map(async (session) => {
      const fields = [searchField(session.name ?? "", TITLE_WEIGHT)];
      const content = await transcriptField(session.path, cache);
      if (content) fields.push(content);
      const score = scoreSearchFields(fields, query);
      if (score !== null) scores[session.id] = score;
    }));
    yield scores;
  }
}
