// FORGE-219 (Loom I2b-1): multi-language code-symbol extraction via bundled
// tree-sitter.
//
// extractSymbols walks a set of repo-relative source files, parses each with the
// matching tree-sitter grammar, runs a vendored definition-capture query, and
// emits `symbol` nodes (functions/classes/methods/types) + `defines` edges
// (file:<relpath> → symbol:<id>). It NEVER reads or stores bodies/docstrings —
// names, kinds, and line spans ONLY (THREAT-MODEL: symbols are stored-not-
// rendered in I2b-1; recall does not surface them yet).
//
// LAZY-LOAD (sacred, mirrors db.ts:openDb's node:sqlite import): web-tree-sitter
// is dynamic-imported INSIDE extractSymbols, never at module top. The wasm core +
// grammars load only when `forge loom reindex` actually extracts — so --version /
// statusline / every non-loom path loads zero wasm and stays byte-silent.
//
// BEST-EFFORT (mirrors the I2a projector): a parse/query/load/read failure on a
// single file degrades to a warning + skip — extractSymbols NEVER throws, so
// reindex still succeeds on a repo with malformed sources / no code at all.
//
// The wasm + queries are COMMITTED under vendor/tree-sitter/ and shipped via
// package.json `files[]` (mirrors templates/): zero extra install, no network.

import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEMORY_ID_MAX_LEN, MEMORY_TITLE_MAX_LEN, type MemoryEdge, type MemoryNode } from '../schemas/memory.ts';

// ── Hard caps (Codex-folded) ────────────────────────────────────────────────
// A hostile/runaway repo must not be able to balloon the graph or hang the walk.
// Generous bounds — real repos sit far below all of these.
const MAX_PARSED_FILES = 5_000;
const MAX_BYTES_PER_FILE = 1024 * 1024; // 1 MiB
const MAX_SYMBOLS_PER_FILE = 2_000;
const MAX_TOTAL_SYMBOLS = 50_000;

// ── Language detection by extension ─────────────────────────────────────────
// Maps a file extension (lowercased, no dot) to a vendored grammar key. An
// unknown extension is skipped SILENTLY (not a warning — most repo files are not
// code we index).
const EXT_TO_LANG: Readonly<Record<string, string>> = {
  py: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  rb: 'ruby',
};

export interface ExtractSymbolsArgs {
  readonly repoRoot: string;
  // Repo-relative posix paths (the file-node paths from the I2a projection).
  // These are UNTRUSTED worker self-reports — each is symlink/containment-guarded
  // before it is read (B2).
  readonly relFiles: readonly string[];
}

export interface ExtractSymbolsResult {
  readonly symbolNodes: MemoryNode[];
  readonly definesEdges: MemoryEdge[];
  readonly warnings: string[];
}

// Locate vendor/tree-sitter/ in both dev (src/) and the shipped npm layout.
// Mirrors resolveTemplatesDir's multi-candidate resolution; vendor/ ships at the
// PACKAGE ROOT via package.json files[]. The extractor is bundled into a loom
// chunk at dist/ (dist/loom-*.cjs), NOT dist/bin/ — so the candidate set covers:
//   Dev:   src/memory/symbols.ts → ../../vendor/tree-sitter   (candidate 1)
//   Built: dist/loom-*.cjs       → ../vendor/tree-sitter      (candidate 3)
// Used for BOTH the core wasm (Parser.init locateFile) and the grammar wasm.
export function resolveGrammarsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'vendor', 'tree-sitter'),
    path.resolve(here, '..', '..', '..', 'vendor', 'tree-sitter'),
    path.resolve(here, '..', 'vendor', 'tree-sitter'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `forge: vendor/tree-sitter directory not found. Looked at: ${candidates.join(', ')}. Reinstall: npm i -g @firatcand/forge`,
  );
}

// Derive a deterministic, always-bounded symbol node id. The raw key
// `<relpath>#<name>@<startLine>` disambiguates overloads/dupes and is a pure fn
// of the source (idempotent reindex), but a long path/name could blow the id
// bound — so we hash it. `symbol:` + 64 hex chars = 71 chars, always ≤256.
function symbolId(relPosix: string, name: string, startLine: number, startCol: number): string {
  // Include the start COLUMN (GPT-5.5 NB) so multiple definitions sharing a name
  // on the SAME line (e.g. compact C++ overloads) get distinct ids instead of
  // collapsing through the dedupe set.
  const raw = `${relPosix}#${name}@${startLine}:${startCol}`;
  const hex = createHash('sha256').update(raw).digest('hex');
  return `symbol:${hex}`;
}

// Read a source file ONLY through a symlink-safe, repo-contained path (B2). The
// I2a file paths are untrusted worker self-reports, so before reading we:
//   1. resolve the candidate absolute path under repoRoot,
//   2. lstat it — reject anything that is not a regular file (symlink, dir, …),
//   3. realpath-containment-check the resolved path stays under repoRoot,
//   4. open with O_NOFOLLOW (TOCTOU: reject a symlink swapped in after lstat,
//      mirroring workspace.copyFileNoFollow / FORGE-143) + fstat regular-file,
//   5. enforce the per-file byte cap.
// Returns the file contents, or null when the path is unsafe / oversize / absent
// (the caller warns + skips). NEVER throws.
function safeReadSource(
  repoRoot: string,
  relPosix: string,
  warnings: string[],
): string | null {
  const repoRootReal = (() => {
    try {
      return realpathSync(repoRoot);
    } catch {
      return path.resolve(repoRoot);
    }
  })();
  const abs = path.resolve(repoRoot, relPosix);

  // lstat: the path's own type (never the target's). Reject non-regular files.
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warnings.push(`loom symbols: could not lstat '${relPosix}': ${(err as Error).message} — skipped`);
    }
    return null;
  }
  if (st.isSymbolicLink()) {
    warnings.push(`loom symbols: '${relPosix}' is a symlink — skipped`);
    return null;
  }
  if (!st.isFile()) {
    return null; // dir / fifo / device — silently not a source file
  }

  // realpath-containment: the resolved path must stay under repoRoot. A symlinked
  // PARENT component could otherwise let abs escape the tree.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    warnings.push(`loom symbols: could not realpath '${relPosix}': ${(err as Error).message} — skipped`);
    return null;
  }
  const rel = path.relative(repoRootReal, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    warnings.push(`loom symbols: '${relPosix}' resolves outside the repo — skipped`);
    return null;
  }

  // O_NOFOLLOW open + fstat (TOCTOU guard — a symlink swapped in after the lstat
  // above cannot be followed; ELOOP → skip). POSIX-only, consistent with
  // workspace.copyFileNoFollow.
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      warnings.push(`loom symbols: '${relPosix}' became a symlink (O_NOFOLLOW) — skipped`);
    } else if (code !== 'ENOENT') {
      warnings.push(`loom symbols: could not open '${relPosix}': ${(err as Error).message} — skipped`);
    }
    return null;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      warnings.push(`loom symbols: '${relPosix}' is not a regular file — skipped`);
      return null;
    }
    // GPT-5.5 B2 — post-open containment re-check closing the parent-swap TOCTOU:
    // O_NOFOLLOW only guards the LEAF, so a parent dir swapped to a symlink between
    // the realpath() above and this open() could point the fd at a file OUTSIDE the
    // repo. The realpath-contained path `real` was verified under repoRoot; assert
    // the opened fd is that SAME inode (dev+ino). A mismatch means a swap happened
    // mid-flight → skip.
    try {
      const realStat = statSync(real);
      if (fst.dev !== realStat.dev || fst.ino !== realStat.ino) {
        warnings.push(`loom symbols: '${relPosix}' changed between checks (TOCTOU) — skipped`);
        return null;
      }
    } catch {
      warnings.push(`loom symbols: '${relPosix}' vanished between checks — skipped`);
      return null;
    }
    if (fst.size > MAX_BYTES_PER_FILE) {
      warnings.push(
        `loom symbols: '${relPosix}' is ${fst.size} bytes (> ${MAX_BYTES_PER_FILE} cap) — skipped`,
      );
      return null;
    }
    const buf = Buffer.allocUnsafe(fst.size);
    let offset = 0;
    while (offset < fst.size) {
      const n = readSync(fd, buf, offset, fst.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString('utf8');
  } catch (err) {
    warnings.push(`loom symbols: could not read '${relPosix}': ${(err as Error).message} — skipped`);
    return null;
  } finally {
    closeSync(fd);
  }
}

// Map a capture name like `def.function` → the kind `function`. The query tags
// each definition node with `@def.<kind>` (and the identifier with `@name`); we
// read the kind from the capture name so one query handles all kinds.
function kindFromCapture(captureName: string): string | null {
  if (!captureName.startsWith('def.')) return null;
  const k = captureName.slice('def.'.length);
  return k.length > 0 ? k : null;
}

export async function extractSymbols(args: ExtractSymbolsArgs): Promise<ExtractSymbolsResult> {
  const warnings: string[] = [];
  const symbolNodes: MemoryNode[] = [];
  const definesEdges: MemoryEdge[] = [];
  // Dedup symbol ids (same hashed id from a duplicate file entry) so the graph
  // has one node per (file,name,line) and reindex stays idempotent.
  const seenSymbolIds = new Set<string>();
  let totalSymbols = 0;

  // Only consider files whose extension maps to a grammar — saves loading wasm
  // for a repo with zero indexable code (the common adopter case → fast no-op).
  const indexable = args.relFiles.filter((rel) => {
    const ext = path.extname(rel).slice(1).toLowerCase();
    return ext.length > 0 && ext in EXT_TO_LANG;
  });
  if (indexable.length === 0) {
    return { symbolNodes, definesEdges, warnings };
  }

  // Resolve the vendored asset dir up-front; a missing vendor dir is a packaging
  // error → warn + return empty (never throw reindex).
  let grammarsDir: string;
  try {
    grammarsDir = resolveGrammarsDir();
  } catch (err) {
    warnings.push(`loom symbols: ${(err as Error).message} — no symbols extracted`);
    return { symbolNodes, definesEdges, warnings };
  }

  // LAZY dynamic import + CJS unwrap (web-tree-sitter 0.22 is CJS-style). This is
  // the ONLY place wasm is touched — keeps every non-loom path byte-silent.
  let Parser: any;
  try {
    const mod = (await import('web-tree-sitter')) as any;
    Parser = mod.default ?? mod;
    await Parser.init({ locateFile: () => path.join(grammarsDir, 'tree-sitter.wasm') });
  } catch (err) {
    warnings.push(`loom symbols: failed to init tree-sitter: ${(err as Error).message} — no symbols extracted`);
    return { symbolNodes, definesEdges, warnings };
  }

  // Cache loaded grammars + compiled queries per language (load each wasm once).
  const langCache = new Map<string, { lang: any; query: any } | null>();
  const loadLang = async (langKey: string): Promise<{ lang: any; query: any } | null> => {
    if (langCache.has(langKey)) return langCache.get(langKey) ?? null;
    let entry: { lang: any; query: any } | null = null;
    try {
      const wasmPath = path.join(grammarsDir, `tree-sitter-${langKey}.wasm`);
      const scmPath = path.join(grammarsDir, 'queries', `${langKey}-tags.scm`);
      const lang = await Parser.Language.load(wasmPath);
      const scm = readFileSync(scmPath, 'utf8');
      const query = lang.query(scm);
      entry = { lang, query };
    } catch (err) {
      warnings.push(`loom symbols: could not load grammar '${langKey}': ${(err as Error).message} — those files skipped`);
      entry = null;
    }
    langCache.set(langKey, entry);
    return entry;
  };

  // Deterministic order so a cap-truncated walk is reproducible across runs.
  const files = [...indexable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let parsedFiles = 0;
  let truncatedFiles = false;
  let truncatedTotal = false;

  for (const relPosix of files) {
    if (parsedFiles >= MAX_PARSED_FILES) {
      truncatedFiles = true;
      break;
    }
    const ext = path.extname(relPosix).slice(1).toLowerCase();
    const langKey = EXT_TO_LANG[ext];
    if (!langKey) continue; // unknown ext → skip silently

    const src = safeReadSource(args.repoRoot, relPosix, warnings);
    if (src === null) continue; // unsafe / oversize / absent — already warned
    parsedFiles += 1;

    const loaded = await loadLang(langKey);
    if (!loaded) continue;

    // Parse + query are wrapped: any grammar/query failure on one file → warn +
    // skip, never throw the whole reindex.
    let captures: Array<{ name: string; node: { text: string; startPosition: { row: number; column: number }; endPosition: { row: number } } }>;
    try {
      const parser = new Parser();
      parser.setLanguage(loaded.lang);
      const parsed = parser.parse(src);
      captures = loaded.query.captures(parsed.rootNode);
    } catch (err) {
      warnings.push(`loom symbols: parse/query failed for '${relPosix}': ${(err as Error).message} — skipped`);
      continue;
    }

    // Pair captures: the query emits, per match, a `@def.<kind>` (whole node, for
    // spans) and a `@name` (identifier). They arrive adjacent in document order;
    // track the most recent def to attach to the following name.
    let pendingKind: string | null = null;
    let pendingDefStart = 0;
    let pendingDefEnd = 0;
    let pendingDefCol = 0;
    let perFile = 0;
    for (const cap of captures) {
      const kind = kindFromCapture(cap.name);
      if (kind) {
        pendingKind = kind;
        pendingDefStart = cap.node.startPosition.row;
        pendingDefEnd = cap.node.endPosition.row;
        pendingDefCol = cap.node.startPosition.column;
        continue;
      }
      if (cap.name !== 'name' || pendingKind === null) continue;
      if (perFile >= MAX_SYMBOLS_PER_FILE) {
        truncatedFiles = true;
        break;
      }
      if (totalSymbols >= MAX_TOTAL_SYMBOLS) {
        truncatedTotal = true;
        break;
      }
      // Snapshot the def kind/span that preceded this name, then reset the
      // pending state so a stray name without a preceding def can never reuse it.
      const symbolKind = pendingKind;
      const startLine = pendingDefStart + 1; // 1-based (tree-sitter rows are 0-based)
      const endLine = pendingDefEnd + 1;
      const startCol = pendingDefCol;
      pendingKind = null;

      const name = cap.node.text;
      if (!name) continue;
      // GPT-5.5 B1 — a valid source file can hold a pathologically long identifier;
      // the symbol title is bounded by MEMORY_TITLE_MAX_LEN and replaceGraph
      // validates before writing, so an over-long name would throw the WHOLE
      // reindex (LOOM_REINDEX_FAILED) rather than warn+skip. Guard it (such names
      // are minified/generated noise, not useful symbols).
      if (name.length > MEMORY_TITLE_MAX_LEN) {
        warnings.push(
          `loom symbols: symbol name in '${relPosix}' exceeds ${MEMORY_TITLE_MAX_LEN} chars — skipped`,
        );
        continue;
      }
      const id = symbolId(relPosix, name, startLine, startCol);

      // Bounds guard (mirrors ingest/project): a hashed id is always ≤256, but
      // keep the skip+warn shape for defensiveness.
      if (id.length > MEMORY_ID_MAX_LEN) {
        warnings.push(`loom symbols: id too long for '${relPosix}#${name}' — skipped`);
        continue;
      }

      if (seenSymbolIds.has(id)) continue;
      seenSymbolIds.add(id);

      symbolNodes.push({
        id,
        kind: 'symbol',
        // title = the bare symbol name (excluded from FTS — structural only).
        title: name,
        body: '',
        attrs: {
          file: relPosix,
          name,
          kind: symbolKind,
          // numbers as strings: attr values are string|string[]|null.
          start_line: String(startLine),
          end_line: String(endLine),
        },
      });
      definesEdges.push({ src: `file:${relPosix}`, dst: id, kind: 'defines' });
      perFile += 1;
      totalSymbols += 1;
    }

    if (truncatedTotal) break;
  }

  if (truncatedFiles) {
    warnings.push(
      `loom symbols: extraction truncated (caps: ${MAX_PARSED_FILES} files / ${MAX_SYMBOLS_PER_FILE} per file)`,
    );
  }
  if (truncatedTotal) {
    warnings.push(`loom symbols: total-symbol cap (${MAX_TOTAL_SYMBOLS}) reached — extraction truncated`);
  }

  return { symbolNodes, definesEdges, warnings };
}
