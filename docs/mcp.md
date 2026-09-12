# MCP

peasant is an MCP client over **both** transports: stdio for a local server, and
Streamable HTTP for a remote one. Roughly 400 lines and no dependency — it is
JSON-RPC 2.0 and a handshake, and a dependency that speaks to arbitrary external
servers is the last one worth taking on trust.

Only **tools** are implemented. Resources and prompts are absent rather than
half-present, so nothing pretends to support them.

## Configuring

Two files, layered exactly like `.env` and for the same reason — a server you
always want belongs with peasant, one specific to a repository belongs with that
repository:

```
~/.config/peasant/mcp.json     (or $PEASANT_HOME/mcp.json)
./.peasant/mcp.json
```

The project file wins by name, so a repository can replace a global server
without disabling it everywhere. The shape is the one every other MCP client
uses, so a block copies across without translation — see `example.mcp.json`.

```json
{ "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "some-server"], "env": {} },
    "remote": { "url": "https://example.com/mcp", "headers": {} }
} }
```

`command` means stdio, `url` means HTTP, and declaring both is an error rather
than a preference to guess at. `"disabled": true` removes a server. A malformed
file is reported by name — silently ignoring it means a server that simply never
appears and nothing saying why.

`peasant mcp` lists what loaded, what each server offers, and which tools will
ask before running.

## Worked example: codebase-memory-mcp

This machine already runs `codebase-memory-mcp` under Claude Code. Translating
that configuration is the shortest way to show how the two line up.

**As Claude Code has it**, in `~/.claude.json` at the top level, which is its
global scope:

```json
"mcpServers": { "codebase-memory-mcp": { "command": "/home/danny/.local/bin/codebase-memory-mcp", "args": [] } }
```

**The peasant equivalent**, in `~/.config/peasant/mcp.json`:

```json
{ "mcpServers": {
    "codebase-memory": {
      "command": "/home/danny/.local/bin/codebase-memory-mcp",
      "args": [],
      "alwaysAllow": [
        "search_graph", "query_graph", "trace_path", "get_code_snippet",
        "get_architecture", "get_graph_schema", "search_code",
        "list_projects", "index_status", "check_index_coverage"
      ]
    }
} }
```

Verified: peasant connects and enumerates all fifteen tools.

```
$ peasant mcp
codebase-memory codebase-memory-mcp 0.10.8 · 15 tools
  index_repository (asks first)
  search_graph (alwaysAllow)
  ...
```

**Why the `alwaysAllow` list.** This server declares
`annotations.readOnlyHint` on **one of its fifteen tools**. Everything peasant
is not told is read-only is treated as mutating, so without that list it would
prompt before every graph query — correct, and unusable. Naming them is a
deliberate act by whoever set the server up, which is the right place for the
decision. `index_repository` and `delete_project` are left off, because they do
change something.

### Translating any Claude Code server

| Claude Code | peasant |
|---|---|
| `~/.claude.json`, top level | `~/.config/peasant/mcp.json` |
| `~/.claude.json`, under `projects.<path>.mcpServers` | `.peasant/mcp.json` in that project |
| `.mcp.json` in a project | `.peasant/mcp.json` |
| `"type": "http"` | omit it — `url` means HTTP, `command` means stdio |
| `"type": "stdio"` | omit it |

The `type` field is ignored rather than rejected, so a block copies across
unchanged. Two HTTP servers configured here translate the same way:

```json
{ "mcpServers": {
    "campione":        { "url": "http://localhost:7220/mcp" },
    "plugin-universe": { "url": "https://mcp.plugin-universe.com/mcp" }
} }
```

`http://localhost` is allowed because loopback never leaves the machine;
anything else must be `https`.

### A caveat that is this project's whole subject

`codebase-memory-mcp` is a **293 MB statically linked prebuilt binary**.
Disassembling it finds AVX-512 (`vmovdqu64`, `vptestmb`), AVX (`vzeroupper`),
FMA (`vfmaddsd`), SSE4.2 (`pcmpistri`) and SSSE3 (`palignr`) — **none of which
the Athlon II has**.

That does not mean it crashes there. A binary containing AVX-512 must be doing
runtime dispatch, or it would fail on nearly every CPU in existence, and one of
the counts is reassuring on its own: `tzcnt` decodes as `bsf` on a CPU without
BMI1, so those 1,254 occurrences are harmless. But `pcmpistri` and `palignr` in
an unguarded path would be fatal, and nothing here can tell from the outside.

**So test it before relying on it**, on the target and not on a development
machine:

```sh
codebase-memory-mcp --version || echo "exit $?"    # SIGILL shows as exit 132
```

If it dies there, that is the same failure peasant exists to avoid, arriving
through a server rather than through the harness — and the answer is the same
one: peasant runs fine, and the server does not. An MCP server is somebody
else's build, and peasant's rule against shipping binaries cannot extend to
binaries it merely talks to.

## How a server's tools become peasant's

Nothing downstream can tell the difference: the agent loop, the permission
policy and the token estimator all see a `Tool` and treat it as they treat
`read` or `bash`.

- **Names are sanitised** to `mcp_<server>_<tool>`, because tool names here must
  be lower snake case and MCP servers use dashes, dots and capitals freely. The
  server's own name is kept for the actual call. Two servers whose tools
  sanitise to the same name are kept apart with a suffix — a silent overwrite
  means calls going to the wrong server, which is hard to notice and annoying to
  diagnose.
- **The schema is passed through as the server gave it.** The server knows what
  it accepts, so it is not rewritten, and it is validated loosely: strict
  validation would refuse a perfectly good schema for using a keyword peasant's
  small subset does not implement.
- **Anything not declared read-only is treated as mutating.** MCP makes
  `annotations.readOnlyHint` optional, so its absence is read as "this might
  change something" and the permission prompt applies. The cost of being wrong
  that way is an extra prompt; the other way it is a server deleting something
  unasked.

  In practice most servers declare it on nothing — `codebase-memory-mcp` on one
  tool of fifteen — so a server's block may list `alwaysAllow` with the server's
  own tool names, or `"*"` for all of them. That is a deliberate decision by
  whoever configured the server, and the tool is still honestly described as
  mutating; it simply does not prompt.
- **A tool's own failure is a result, not an error.** MCP reports it in the
  result rather than as a protocol error, which is right — the call succeeded,
  the tool did not — and the model can usually work around one.

## What the transports have to get right

**stdio.** Newline-delimited JSON-RPC on stdin and stdout. The server's stderr
is captured but never mixed into the protocol stream: many servers log there,
and a log line parsed as a message is a confusing way to fail.

**Streamable HTTP.** Every message is a POST, and the reply is *either* a single
JSON object *or* an SSE stream carrying one — the server chooses, by content
type, and a client that handles only one works against half the servers it
meets. The SSE half reuses `src/provider/SseParser.js`, written for streamed
completions: the framing problem is identical, down to a `data:` line splitting
mid-UTF-8. Both modes are tested.

Two further details that are easy to miss and produce puzzling failures:

- The server assigns a session on `initialize` via `mcp-session-id` and expects
  it echoed on everything after. Without it, a server that has just finished
  initialising answers "not initialised".
- The `notifications/initialized` notification is required, and servers enforce
  it. Skipping it leaves the handshake unfinished and everything after refused.

**`tools/list` is paginated**, and a server with many tools does paginate. A
client that reads the first page silently loses the rest.

## Security

- A remote server must be `https`, unless the host is loopback. Headers may
  carry a token and a token must not cross a network in plaintext — the same
  rule, and the same code, as a provider endpoint.
- An MCP server's tools go through the same permission policy as `bash`. It is
  somebody else's code running on your machine.
- A stdio server gets the parent environment plus whatever its own `env` block
  adds — never peasant's provider keys by accident.
- A broken server does not stop peasant starting. They are other people's
  processes and other people's hosts; one being broken is a normal Tuesday.
