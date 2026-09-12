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
