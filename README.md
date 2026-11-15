# forge — a GitHub-compatible git forge in one file

A single-process, standard-library-only Node server that speaks four surfaces
from one in-memory store:

- **git smart HTTP** at `/<owner>/<repo>.git/…` — protocol v2 `ls-refs` and
  `fetch` (with shallow/deepen support), a v0 fetch fallback, and v0
  `receive-pack` pushes with `report-status` over `side-band-64k`. Packfiles
  are parsed and generated in-process (SHA-1 object model, OFS/REF delta
  resolution on receive, plain-object packs on send).
- **REST v3** at `/api/v3/…` — repositories (create/list/get/patch/delete),
  branches, commits, git refs, the contents API (create/update/delete files
  as real git commits), labels, issues with comments, and pull requests with
  file diffs and squash/merge merging (three-way tree merge; conflicts are
  refused with 405).
- **GraphQL v4** at `/api/graphql` — a small hand-written parser/executor:
  `viewer`, `repository`, `node(id:)`, `__type` introspection, issue
  connections with cursor pagination and `orderBy`, pull requests, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations. Operation batching (JSON array bodies) is supported,
  global ids are opaque and stable, and everything reads and writes the same
  store as REST.
- **MCP** at `/mcp` — streamable-HTTP JSON-RPC with plain JSON answers:
  `server/discover` (revision 2026-07-28), the legacy `initialize` handshake,
  and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) over the same store.

## Running

```sh
node --experimental-strip-types main.ts
```

Environment (the make.fun trial envelope):

- `MAKEFUN_ENV_URL` — the env's base URL. When set, the forge POSTs
  `{"port": N}` to `$MAKEFUN_ENV_URL/register` after binding an ephemeral
  port, polls `$MAKEFUN_ENV_URL/done`, and exits 0 when it answers done.
  When unset, the forge simply serves until killed (local development).
- `MAKEFUN_SHOP_TOKEN` — the bearer token every surface (except
  `GET /healthz`) requires as `Authorization: Bearer <token>`.
- `MAKEFUN_TRIAL_NOW` — the trial's opening time; seeds the logical clock.

## Design notes

- **One store, four views.** A repository is a map of git objects plus refs,
  issues, pull requests and labels. Contents-API writes, REST merges, GraphQL
  mutations, MCP tools and git pushes all mutate that same store, so an
  object created through any surface is immediately visible through the rest.
- **Determinism.** No wall clock appears in any response: timestamps come
  from a logical clock seeded by `MAKEFUN_TRIAL_NOW` (fixed epoch otherwise)
  and advanced once per use, and every id comes from a counter. Identical
  request sequences produce identical pass bits and bytes.
- **Merges are real.** Pull-request merging computes a merge-base and a
  three-way tree merge; both-sides-changed paths are conflicts (405), and a
  squash merge lands as a single-parent commit carrying the head's changes.
- **Errors are JSON everywhere.** REST errors are `{"message": …}` with an
  `X-GitHub-Request-Id` on every reply; unknown `/api/v3` routes are JSON
  404s; a repository that belongs to another owner is a 404, never a 403.

## License

MIT — see `LICENSE`.
