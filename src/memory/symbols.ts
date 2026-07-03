// FORGE-219 (Loom I2b-1): multi-language code-symbol extraction via bundled
// tree-sitter. FORGE-229 (Loom I2b-2) extends it with reference extraction.
//
// extractSymbols walks a set of repo-relative source files, parses each with the
// matching tree-sitter grammar, runs a vendored definition-capture query, and
// emits `symbol` nodes (functions/classes/methods/types) + `defines` edges
// (file:<relpath> → symbol:<id>). A second vendored query (`<lang>-refs.scm`)
// captures call/usage sites; a post-walk resolution pass turns them into
// symbol→symbol `references` edges (tiered: unique-same-file match, else
// unique-repo-wide match, else dropped + counted). It NEVER reads or stores
// bodies/docstrings — names, kinds, and line spans ONLY. Symbol names are
// additionally constrained to an identifier charset whitelist at extraction
// (THREAT-MODEL I2b-2: constrain-at-write + tripwire-scan-at-read; recall
// surfaces symbol names since FORGE-227).
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
// FORGE-229: reference-capture bounds. Raw captures are collected per file then
// resolved after the walk (the global name index must be complete first) — cap
// BOTH the per-file capture count and the total collected set so an adversarial
// repo cannot balloon the pending list, and cap the emitted edge count.
const MAX_REFS_PER_FILE = 2_000;
const MAX_TOTAL_REFS_COLLECTED = 100_000;
const MAX_TOTAL_REF_EDGES = 50_000;

// FORGE-229 (THREAT-MODEL I2b-2, write-side constraint): symbol names — both
// definition names and reference names — must match an identifier charset
// whitelist before they enter the graph. Covers identifiers across all 10
// vendored grammars: letters/digits/_/$ everywhere, ?/! (Ruby method names),
// ~ (C++ destructors). Anything else (whitespace, quotes, braces, unicode) is
// dropped + counted: exotic-but-legit unicode identifiers are a documented,
// user-approved trade-off for keeping injection-shaped text out of stored
// names. 256 is tighter than MEMORY_TITLE_MAX_LEN — longer names are
// minified/generated noise, not useful symbols.
const SYMBOL_NAME_RE = /^[A-Za-z0-9_$?!~]{1,256}$/;

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

// FORGE-229: exposed for the repo-walk source discovery in ingest.ts — a tracked
// file is worth walking only when its extension maps to a vendored grammar.
export function isIndexableSourcePath(relPath: string): boolean {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return ext.length > 0 && ext in EXT_TO_LANG;
}

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
  // FORGE-229 (Loom I2b-2): resolved symbol→symbol call/usage edges.
  readonly referencesEdges: MemoryEdge[];
  // Reference captures that produced NO edge: top-level call sites (no enclosing
  // definition), ambiguous names (2+ candidate definitions), and names with no
  // indexed definition at all. Observability for the tiered-drop policy.
  readonly referencesUnresolved: number;
  // Definition names rejected by the identifier charset whitelist.
  readonly symbolsRejected: number;
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
// Returns the file contents, or null when the path is unsafe / oversize / absent.
// On a skip it calls `bump(<reason>)` with a CONSTANT reason string — it NEVER
// receives or emits the untrusted `relPosix`, because reindex warnings are
// model-visible via /pickup-task and echoing a path would be an injection channel
// (Codex FORGE-229 review). NEVER throws.
function safeReadSource(
  repoRoot: string,
  relPosix: string,
  bump: (reason: SkipReason) => void,
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
    if (code !== 'ENOENT') bump('unreadable');
    return null;
  }
  if (st.isSymbolicLink()) {
    bump('symlink');
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
    bump('unreadable');
    return null;
  }
  const rel = path.relative(repoRootReal, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    bump('outside repo');
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
    if (code === 'ELOOP') bump('symlink');
    else if (code !== 'ENOENT') bump('unreadable');
    return null;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      bump('not a regular file');
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
        bump('changed during read');
        return null;
      }
    } catch {
      bump('changed during read');
      return null;
    }
    if (fst.size > MAX_BYTES_PER_FILE) {
      bump('too large');
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
    bump('unreadable');
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

// Constant skip reasons for the aggregated, path-free extractor warnings.
type SkipReason =
  | 'unreadable'
  | 'symlink'
  | 'outside repo'
  | 'not a regular file'
  | 'too large'
  | 'changed during read'
  | 'file id too long'
  | 'symbol name too long'
  | 'symbol id too long'
  | 'parse error'
  | 'reference query error';

// FORGE-229: a definition's span as a (line, column) rectangle. Columns matter:
// multiple defs can share a line (compact/minified code, one-liner nests), and a
// line-only containment test (Codex re-review MINOR) can pick a later same-line
// sibling as a call site's enclosing def.
interface DefRec {
  readonly id: string;
  readonly name: string;
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

// Lexicographic (line, col) compare.
function posCmp(aL: number, aC: number, bL: number, bC: number): number {
  return aL !== bL ? aL - bL : aC - bC;
}

// FORGE-229: the SRC of a `references` edge is the innermost extracted definition
// whose (line,col) rectangle CONTAINS the call site. `defs` is sorted by start
// position ASC; binary-search the rightmost def whose start <= the call position,
// then walk backward for the first whose end >= it (that is the innermost
// enclosing def). Returns null for a top-level call site (no enclosing def) — the
// caller drops + counts it.
function innermostEnclosingDef(defs: readonly DefRec[], line: number, col: number): string | null {
  let lo = 0;
  let hi = defs.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = defs[mid]!;
    if (posCmp(d.startLine, d.startCol, line, col) <= 0) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = idx; i >= 0; i -= 1) {
    const d = defs[i]!;
    if (posCmp(d.endLine, d.endCol, line, col) >= 0) return d.id;
  }
  return null;
}

export async function extractSymbols(args: ExtractSymbolsArgs): Promise<ExtractSymbolsResult> {
  const warnings: string[] = [];
  const symbolNodes: MemoryNode[] = [];
  const definesEdges: MemoryEdge[] = [];
  const referencesEdges: MemoryEdge[] = [];
  let referencesUnresolved = 0;
  let symbolsRejected = 0;
  // Dedup symbol ids (same hashed id from a duplicate file entry) so the graph
  // has one node per (file,name,line) and reindex stays idempotent.
  const seenSymbolIds = new Set<string>();
  let totalSymbols = 0;
  // FORGE-229 reference-resolution state, populated during the walk and consumed
  // in a post-walk pass (the global name index must be COMPLETE before any callee
  // resolves — a ref in file A may resolve to a def in file Z walked later).
  //   nameToIds:  callee name → every symbol id defined under it (repo-wide tier).
  //   defsByFile: file → its defs (enclosing-src lookup + same-file callee tier).
  //   pendingRefs: raw call sites awaiting resolution.
  const nameToIds = new Map<string, string[]>();
  const defsByFile = new Map<string, DefRec[]>();
  const pendingRefs: Array<{ file: string; name: string; line: number; col: number }> = [];
  let totalRefsCollected = 0;
  let truncatedRefs = false;

  // Aggregated, path-free skip tally (Codex re-review MAJOR): every per-file skip
  // increments a count keyed by a CONSTANT reason; summaries are emitted at the
  // end so no untrusted path/name ever reaches the model-visible warnings.
  const skipTally = new Map<SkipReason, number>();
  const bumpSkip = (reason: SkipReason): void => {
    skipTally.set(reason, (skipTally.get(reason) ?? 0) + 1);
  };

  // Only consider files whose extension maps to a grammar — saves loading wasm
  // for a repo with zero indexable code (the common adopter case → fast no-op).
  const indexable = args.relFiles.filter((rel) => {
    const ext = path.extname(rel).slice(1).toLowerCase();
    return ext.length > 0 && ext in EXT_TO_LANG;
  });
  if (indexable.length === 0) {
    return { symbolNodes, definesEdges, referencesEdges, referencesUnresolved, symbolsRejected, warnings };
  }

  // Resolve the vendored asset dir up-front; a missing vendor dir is a packaging
  // error → warn + return empty (never throw reindex).
  let grammarsDir: string;
  try {
    grammarsDir = resolveGrammarsDir();
  } catch (err) {
    warnings.push(`loom symbols: ${(err as Error).message} — no symbols extracted`);
    return { symbolNodes, definesEdges, referencesEdges, referencesUnresolved, symbolsRejected, warnings };
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
    return { symbolNodes, definesEdges, referencesEdges, referencesUnresolved, symbolsRejected, warnings };
  }

  // Cache loaded grammars + compiled queries per language (load each wasm once).
  // FORGE-229: `refsQuery` is the `<lang>-refs.scm` call/usage query — OPTIONAL
  // (a missing/invalid refs file degrades to defines-only for that language, never
  // killing symbol extraction).
  const langCache = new Map<string, { lang: any; query: any; refsQuery: any } | null>();
  const loadLang = async (langKey: string): Promise<{ lang: any; query: any; refsQuery: any } | null> => {
    if (langCache.has(langKey)) return langCache.get(langKey) ?? null;
    let entry: { lang: any; query: any; refsQuery: any } | null = null;
    try {
      const wasmPath = path.join(grammarsDir, `tree-sitter-${langKey}.wasm`);
      const scmPath = path.join(grammarsDir, 'queries', `${langKey}-tags.scm`);
      const lang = await Parser.Language.load(wasmPath);
      const scm = readFileSync(scmPath, 'utf8');
      const query = lang.query(scm);
      let refsQuery: any = null;
      try {
        const refsScmPath = path.join(grammarsDir, 'queries', `${langKey}-refs.scm`);
        refsQuery = lang.query(readFileSync(refsScmPath, 'utf8'));
      } catch (refErr) {
        // langKey is a fixed grammar key (safe); drop the error detail so no
        // vendored-asset path leaks into the model-visible warning.
        warnings.push(`loom symbols: no/invalid ref query for '${langKey}' — references skipped for this language`);
      }
      entry = { lang, query, refsQuery };
    } catch (err) {
      warnings.push(`loom symbols: could not load grammar '${langKey}' — those files skipped`);
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

    // FORGE-229 (Codex MAJOR#2): the repo-source walk feeds paths straight in,
    // bypassing the projector's own id-length guard. A `file:<relpath>` id over the
    // schema bound would slip a too-long `defines` edge src into replaceGraph and
    // FAIL the whole reindex. Skip such a file up-front (before any read/parse).
    if (`file:${relPosix}`.length > MEMORY_ID_MAX_LEN) {
      bumpSkip('file id too long');
      continue;
    }

    const src = safeReadSource(args.repoRoot, relPosix, bumpSkip);
    if (src === null) continue; // unsafe / oversize / absent — already tallied
    parsedFiles += 1;

    const loaded = await loadLang(langKey);
    if (!loaded) continue;

    // Parse + query are wrapped: any grammar/query failure on one file → tally +
    // skip, never throw the whole reindex. The refs query runs on the SAME parse
    // tree (no re-read, no re-parse); a refs-query failure degrades to defs-only.
    let captures: Array<{ name: string; node: { text: string; startPosition: { row: number; column: number }; endPosition: { row: number; column: number } } }>;
    let refCaptures: Array<{ name: string; node: { text: string; startPosition: { row: number; column: number } } }> = [];
    try {
      const parser = new Parser();
      parser.setLanguage(loaded.lang);
      const parsed = parser.parse(src);
      captures = loaded.query.captures(parsed.rootNode);
      if (loaded.refsQuery) {
        try {
          refCaptures = loaded.refsQuery.captures(parsed.rootNode);
        } catch (refErr) {
          bumpSkip('reference query error');
        }
      }
    } catch (err) {
      bumpSkip('parse error');
      continue;
    }

    // Pair captures: the query emits, per match, a `@def.<kind>` (whole node, for
    // spans) and a `@name` (identifier). They arrive adjacent in document order;
    // track the most recent def to attach to the following name.
    let pendingKind: string | null = null;
    let pendingDefStart = 0;
    let pendingDefEnd = 0;
    let pendingDefStartCol = 0;
    let pendingDefEndCol = 0;
    let perFile = 0;
    for (const cap of captures) {
      const kind = kindFromCapture(cap.name);
      if (kind) {
        pendingKind = kind;
        pendingDefStart = cap.node.startPosition.row;
        pendingDefEnd = cap.node.endPosition.row;
        pendingDefStartCol = cap.node.startPosition.column;
        pendingDefEndCol = cap.node.endPosition.column;
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
      const startCol = pendingDefStartCol;
      const endCol = pendingDefEndCol;
      pendingKind = null;

      const name = cap.node.text;
      if (!name) continue;
      // GPT-5.5 B1 — a valid source file can hold a pathologically long identifier;
      // the symbol title is bounded by MEMORY_TITLE_MAX_LEN and replaceGraph
      // validates before writing, so an over-long name would throw the WHOLE
      // reindex (LOOM_REINDEX_FAILED) rather than tally+skip. Guard it (such names
      // are minified/generated noise, not useful symbols).
      if (name.length > MEMORY_TITLE_MAX_LEN) {
        bumpSkip('symbol name too long');
        continue;
      }
      // FORGE-229 (THREAT-MODEL I2b-2, constrain-at-write): a stored symbol name
      // flows into recall `why` strings / worker prompts (since FORGE-227), so it
      // must be a plain identifier — no whitespace, quotes, or injection-shaped
      // punctuation. A definition whose name fails the whitelist is dropped +
      // counted (not indexed, so it can never be a reference DST either).
      if (!SYMBOL_NAME_RE.test(name)) {
        symbolsRejected += 1;
        continue;
      }
      const id = symbolId(relPosix, name, startLine, startCol);

      // Bounds guard (mirrors ingest/project): a hashed id is always ≤256, but
      // keep the skip+tally shape for defensiveness.
      if (id.length > MEMORY_ID_MAX_LEN) {
        bumpSkip('symbol id too long');
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
      // FORGE-229: record for reference resolution (repo-wide name index +
      // per-file span list). Both use the SAME id/name/span that built the node.
      const ids = nameToIds.get(name);
      if (ids) ids.push(id);
      else nameToIds.set(name, [id]);
      const fileDefs = defsByFile.get(relPosix);
      const rec: DefRec = { id, name, startLine, startCol, endLine, endCol };
      if (fileDefs) fileDefs.push(rec);
      else defsByFile.set(relPosix, [rec]);
      perFile += 1;
      totalSymbols += 1;
    }

    // FORGE-229: collect this file's call sites (resolved after the full walk).
    // Bounded per file + globally so an adversarial file cannot balloon the
    // pending list. A non-identifier callee (charset-failing) is skipped — it can
    // never match an indexed def name, so dropping it here is free.
    let perFileRefs = 0;
    for (const cap of refCaptures) {
      if (cap.name !== 'ref.call') continue;
      if (perFileRefs >= MAX_REFS_PER_FILE) break;
      if (totalRefsCollected >= MAX_TOTAL_REFS_COLLECTED) {
        truncatedRefs = true;
        break;
      }
      const rname = cap.node.text;
      if (!rname || !SYMBOL_NAME_RE.test(rname)) continue;
      pendingRefs.push({
        file: relPosix,
        name: rname,
        line: cap.node.startPosition.row + 1,
        col: cap.node.startPosition.column,
      });
      perFileRefs += 1;
      totalRefsCollected += 1;
    }

    if (truncatedTotal) break;
  }

  // ── FORGE-229: resolve pending references into symbol→symbol edges. ──
  // Tiered (locked decision): SRC = innermost enclosing def in the SAME file;
  // DST = (1) unique same-file def of the callee name, else (2) unique repo-wide
  // def, else DROP + count. Recursive self-calls (src === dst) are KEPT. Edges
  // deduped by (src,dst) and sorted for idempotency.
  if (pendingRefs.length > 0) {
    for (const defs of defsByFile.values()) {
      defs.sort(
        (a, b) =>
          posCmp(a.startLine, a.startCol, b.startLine, b.startCol) ||
          posCmp(a.endLine, a.endCol, b.endLine, b.endCol),
      );
    }
    const seenRefEdges = new Set<string>();
    for (const ref of pendingRefs) {
      if (referencesEdges.length >= MAX_TOTAL_REF_EDGES) {
        truncatedRefs = true;
        break;
      }
      const fileDefs = defsByFile.get(ref.file);
      if (!fileDefs) {
        referencesUnresolved += 1;
        continue;
      }
      const src = innermostEnclosingDef(fileDefs, ref.line, ref.col);
      if (!src) {
        referencesUnresolved += 1; // top-level call site — no enclosing def
        continue;
      }
      const sameFile = fileDefs.filter((d) => d.name === ref.name);
      let dst: string | null = null;
      if (sameFile.length === 1) {
        dst = sameFile[0]!.id;
      } else if (sameFile.length >= 2) {
        referencesUnresolved += 1; // ambiguous within the file — drop (locked)
        continue;
      } else {
        const global = nameToIds.get(ref.name);
        if (global && global.length === 1) dst = global[0]!;
        else {
          referencesUnresolved += 1; // unknown, or ambiguous repo-wide — drop
          continue;
        }
      }
      const key = `${src}|${dst}`;
      if (seenRefEdges.has(key)) continue;
      seenRefEdges.add(key);
      referencesEdges.push({ src, dst, kind: 'references' });
    }
    referencesEdges.sort((a, b) =>
      a.src !== b.src ? (a.src < b.src ? -1 : 1) : a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0,
    );
  }

  if (truncatedFiles) {
    warnings.push(
      `loom symbols: extraction truncated (caps: ${MAX_PARSED_FILES} files / ${MAX_SYMBOLS_PER_FILE} per file)`,
    );
  }
  if (truncatedTotal) {
    warnings.push(`loom symbols: total-symbol cap (${MAX_TOTAL_SYMBOLS}) reached — extraction truncated`);
  }
  if (truncatedRefs) {
    warnings.push(
      `loom symbols: reference extraction truncated (caps: ${MAX_REFS_PER_FILE} per file / ${MAX_TOTAL_REF_EDGES} edges)`,
    );
  }
  // Emit ONE constants-only summary per skip reason (sorted for stable output).
  // The reason strings are a fixed enum — no untrusted path/name is ever echoed
  // into these model-visible warnings (Codex re-review MAJOR).
  for (const reason of [...skipTally.keys()].sort()) {
    warnings.push(`loom symbols: ${skipTally.get(reason)} source file(s) skipped (${reason})`);
  }

  return { symbolNodes, definesEdges, referencesEdges, referencesUnresolved, symbolsRejected, warnings };
}
