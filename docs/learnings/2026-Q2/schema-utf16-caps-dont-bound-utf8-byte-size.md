# Schema length caps in UTF-16 code units don't bound UTF-8 byte size

> 2026-05-14 · FORGE-69 · tags: [schema, encoding, defense-in-depth, file-size-caps, zod]

## What we expected
The question schema caps every string field by length (e.g. `z.string().max(8000)` on `context`). The orchestrator imposes a 64KB cap on each question/answer file on disk. Naively summed, the per-field caps multiplied by their max counts come to roughly 39KB worst case — well under 64KB. Conclusion (wrong): the byte cap is unreachable through the public API and the write-side `PAYLOAD_TOO_LARGE` check is theoretical defense.

## What happened
Zod's `z.string().max(N)` counts **UTF-16 code units** (it uses `String#length`). The 64KB cap is enforced in **UTF-8 bytes** (`Buffer.byteLength(payload, 'utf8')` on disk). A surrogate-pair codepoint like an emoji is 2 UTF-16 units but 4 UTF-8 bytes. A payload of all-emoji strings at every schema maximum passes validation cleanly and produces a JSON document of ~65KB — over the byte cap. Test T6 reproduces this: 2000 emoji in `question` (4000 UTF-16 = cap), 4000 emoji in `context` (8000 UTF-16 = cap), 1000 emoji × 10 option descriptions, plus `what_happens_if_unanswered` — total 65,012 bytes UTF-8, schema-valid, would have landed an oversized file in the mailbox without the write-side check.

## Why
JS strings are UTF-16 internally; `length` returns code-unit count. UTF-8 byte length differs whenever a codepoint encodes to more bytes in UTF-8 than UTF-16 code units in JS. ASCII: 1=1. BMP non-ASCII (most Latin/Greek/Cyrillic etc.): 1 UTF-16 unit, 2-3 UTF-8 bytes. Supplementary plane (emoji, many CJK extensions, math symbols): 2 UTF-16 units (surrogate pair), 4 UTF-8 bytes. The worst-case ratio is 2× (supplementary plane) — so any cap built on `String#length` may admit 2× the bytes of an equivalent BMP-only check.

## Next time
When a "size cap" needs to align between a schema validator and a byte-counted resource (disk, network, DB column with BYTES not CHARS), enforce the byte budget at the resource boundary — never trust that summed schema caps will stay under it. Two cheap defaults for new schemas: (a) document in the field comment whether the cap is code units or bytes; (b) for any field where the byte budget matters, prefer `.refine(s => Buffer.byteLength(s, 'utf8') <= N)` over `.max(N)`. Also: when reasoning about "can the schema produce X kB?", always plug in supplementary-plane characters for the worst case, not ASCII. The dispatcher logs keep `OVERSIZED` (read-side) and `PAYLOAD_TOO_LARGE` (write-side) distinct precisely so this gap is unambiguous in post-mortems.
