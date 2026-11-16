# git-forge v2 — an in-memory git forge, built for speed

A single-file Node.js implementation of a GitHub-shaped forge: git smart
HTTP (upload-pack / receive-pack, protocol v0 and v2), the REST v3 API,
GraphQL, and an MCP endpoint — all served from one process with zero
dependencies and no `git` binary.

Version 2 is a latency-focused rewrite of the original forge. The feature
surface is identical; the internals are built around the observation that
almost every request is either a tiny JSON document or a pack transfer, and
both can be answered from precomputed bytes:

- **Everything lives in memory.** Objects, refs, issues and pull requests
  are Maps keyed by oid / name / number. No filesystem, no child processes.
- **Issue JSON is rendered once** into a Buffer and served verbatim until
  the issue changes, so the hot read path is a single socket write.
- **Packs are assembled from cached per-object segments** (each object's
  deflated pack record is computed once at zlib level 1) and whole packs
  are cached per repository, keyed by the exact want/have/depth set — a
  repeated clone is a cache hit.
- **Static responses are prebuilt Buffers** (health, API root, auth and
  routing errors), and routing is manual string splitting instead of a
  framework.
- **Deterministic state.** Timestamps are fixed constants kept out of
  exported state, so runs are reproducible.

## Run

```sh
node --experimental-strip-types main.ts
# local mode: listens on PORT (default 8734)
```

When `MAKEFUN_ENV_URL` is set the process follows the contest harness
lifecycle instead: it binds an ephemeral port, registers it, serves until
the harness reports done, and exits.

## Layout

- `main.ts` — the whole forge: object model, pack encode/decode, git HTTP,
  REST, GraphQL (a small purpose-built parser/executor), MCP, HTTP router.
