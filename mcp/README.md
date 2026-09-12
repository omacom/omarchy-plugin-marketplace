# Marketplace MCP server

The Marketplace MCP server gives AI agents structured, read-only access to the
current plugin catalog and submission inspection rules. It supports local stdio
and a separately deployable stateless Streamable HTTP adapter. Both transports
use the same service and expose the same tools and resources.

No public MCP endpoint is deployed by this repository. Merging the source does
not provision Cloudflare credentials, create DNS records, or deploy the Worker.

## Capabilities

| Tool | Result |
| --- | --- |
| `search_plugins` | Bounded catalog results filtered by metadata, taxonomy, verification, and installation state |
| `get_plugin` | One complete public catalog record with source, install, verification, and preview metadata |
| `find_similar_plugins` | Exact repository and plugin-ID conflicts plus advisory title, description, taxonomy, and author similarity |
| `review_candidate` | Exact-commit manifest, repository, documentation, preview, metadata-consistency, duplicate, and submission-readiness report |
| `get_preview` | Listed or exact-commit candidate screenshot as MCP image content |

The server also exposes catalog-summary and submission-policy resources, plus
resource templates for individual plugin records and previews.

Similarity never publishes a security, approval, or rejection decision. Exact
conflicts reuse permanent marketplace identity rules. Similar results identify
plugins that an agent and maintainer should compare manually.

## Implementation map

- `contracts.mjs` owns tool schemas and runtime argument parsing, keeping the
  advertised contract and handler validation together.
- `service.mjs` coordinates the five tool workflows without transport or
  deployment concerns.
- `resources.mjs` owns resource discovery and reads.
- `github-inspector.mjs` performs bounded, exact-commit candidate inspection.
- `duplicates.mjs` separates deterministic identity conflicts from advisory
  similarity scoring.
- `local-adapters.mjs` and `remote-adapters.mjs` provide environment-specific
  catalog and preview access behind the shared service.
- `protocol.mjs`, `server.mjs`, and `worker.mjs` contain protocol behavior,
  stdio transport, and hosted HTTP policy respectively.
- `bounded-response.mjs` and `identifiers.mjs` centralize cross-environment
  safety primitives.

## Local stdio

Install the existing repository dependencies and start the server directly:

```bash
npm ci
node /absolute/path/to/omarchy-plugin-marketplace/mcp/server.mjs
```

Point an MCP client at the direct Node command so package-manager status output
cannot enter the stdio protocol stream:

```json
{
  "mcpServers": {
    "omarchy-plugins": {
      "command": "node",
      "args": [
        "/absolute/path/to/omarchy-plugin-marketplace/mcp/server.mjs"
      ],
      "env": {
        "GITHUB_TOKEN": "optional-public-repository-read-token"
      }
    }
  }
}
```

Catalog search, details, listed previews, and duplicate comparison use local
generated data. Candidate inspection calls GitHub's public API and raw-content
host. `GITHUB_TOKEN` is optional, is sent only to `api.github.com`, and should
have no repository write permission. It is never returned in an MCP result or
forwarded to `raw.githubusercontent.com`.

The stdio server supports the current `2026-07-28` protocol and the legacy
`2025-11-25` and `2025-06-18` initialization sequence.

## Agent review flow

1. Call `review_candidate` with the public repository URL and, when known, a
   full commit SHA.
2. Record the exact resolved commit from `snapshot.commitSha`.
3. Inspect manifest metadata, documentation signals, preview metadata, title
   consistency, and controlled taxonomy values.
4. Stop on `duplicateAnalysis.exactConflicts`.
5. Compare every high-ranked similar plugin. Call `get_plugin` and
   `get_preview` for the candidate and relevant listed plugins when visual or
   functional comparison is useful.
6. Explain that similarity is advisory and candidate inspection is not a
   security review.
7. Show the proposed issue title and body to the plugin owner. Require explicit
   confirmation of every submission checklist statement before creating an
   issue through a separate authorized GitHub tool.

`review_candidate` never executes repository code, creates an issue, changes a
label, edits registry data, or approves a listing.

## Hosted Worker adapter

The HTTP adapter is deliberately separate from the engagement Worker. It reads
the published catalog and canonical registry, uses an ephemeral Cloudflare
rate-limit key, and exposes `POST /mcp`. `GET /health` reports only service and
protocol status.

To test a separately approved deployment:

```bash
cp mcp/wrangler.example.jsonc mcp/wrangler.jsonc
npx wrangler dev --config mcp/wrangler.jsonc --ip 127.0.0.1
```

The general `MCP_RATE_LIMITER` binding is required. Candidate inspection also
requires the stricter `MCP_GITHUB_RATE_LIMITER`; GitHub-backed tools fail closed
when it is unavailable. `CATALOG_URL`, `REGISTRY_URL`, and
`MCP_ALLOWED_ORIGINS` have safe public defaults in the example configuration.
Store an optional GitHub token as a Worker secret:

```bash
npx wrangler secret put GITHUB_TOKEN --config mcp/wrangler.jsonc
```

Verify a `workers.dev` deployment before configuring the commented custom
domain. Hosting also requires a separate maintainer decision covering public
availability, Cloudflare ownership, DNS, abuse limits, token rotation, and
operational monitoring.

## Trust and resource boundaries

- Repository URLs are restricted to public HTTPS GitHub repository roots.
- Candidate snapshots resolve to and report a full commit and tree SHA.
- Manifest and README input is bounded to 1 MB per file.
- GitHub API responses are bounded to 8 MB.
- Candidate preview input remains bounded by the marketplace's 50 MB policy.
- Hosted MCP image delivery is limited to 4 MB; local candidate previews are
  decoded, metadata-stripped, resized, and converted to WebP before delivery.
- Local listed preview paths are restricted to generated plugin assets.
- Hosted requests require current protocol metadata, matching routing headers,
  allowed browser origins when an Origin header exists, and a successful
  general rate-limit check before request-body processing. GitHub-backed calls
  require a second, stricter rate-limit check.
- The service has no account, database, write-token, issue, label, registry,
  deployment, or plugin-execution capability.

## Verification

Run the complete repository suite:

```bash
npm test
```

Focused MCP coverage is available with:

```bash
node --test test/mcp.test.js
```

The focused suite covers tool/resource discovery, search, details, duplicate
classification, candidate inspection, image content, untrusted inputs, current
and legacy stdio, and the HTTP adapter's origin, header, rate-limit, and request
boundaries. Protocol interoperability should additionally be checked against
the current official MCP client or Inspector before release.
