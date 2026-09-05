# Engagement Worker

This Cloudflare Worker stores anonymous aggregate marketplace engagement in D1.
It records three actions:

- `view`: a successfully rendered plugin detail page with a best-effort repeat guard
- `copy`: a successful plugin command copy action with a best-effort repeat guard
- `heart`: an anonymous positive reaction with a best-effort repeat guard

These values describe marketplace activity. They are not downloads, installations,
unique people, verified votes, quality signals, or security signals.

## Privacy and trust boundary

The application does not persist accounts, cookies, browser identifiers, IP addresses,
user-agent strings, command text, repository URLs, or plugin metadata in D1 or application
tables. Event bodies contain only a catalog plugin ID and the fixed action type. D1 stores
anonymous plugin-level aggregates only. Cloudflare processes normal request metadata and
uses the request address only for ephemeral abuse controls: edge burst limits and
Cache-API sliding windows keyed on IPv4 or the IPv6 /64 prefix. Quota cache keys are
hashes, not addresses. The Worker never writes request-derived limit keys to D1.

The public API contains no credentials. D1 is available only through the Worker binding.
Keep the real `wrangler.jsonc`, `.dev.vars`, local Wrangler state, and all credentials out
of version control.

## Local configuration

Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, create the D1 database,
and replace every `REPLACE_WITH_...` placeholder with the matching local identifier or
positive limit. Replace the quoted rate-limit placeholder, including its quotes, with a
positive JSON integer. Apply all migrations before starting the Worker on
`127.0.0.1:8787`.

The production custom-domain route is intentionally commented out in the template.
Verify a workers.dev deployment before adding `api.omarchyplugins.com` to the local
configuration.

## API

- `GET /v1/stats` returns aggregate counts keyed by plugin ID.
- `POST /v1/events` accepts `{ "pluginId": "...", "type": "view" }`,
  `{ "pluginId": "...", "type": "copy" }`, or
  `{ "pluginId": "...", "type": "heart" }` from an allowed marketplace origin.

The Worker validates plugin IDs against the published marketplace catalog and applies
best-effort abuse controls before accepting an event. Origin allowlisting is a browser
CORS control, not authentication; clients can send an allowed Origin header. Browser
storage only suppresses repeats in that browser. Per-plugin daily and minute ceilings
bound a listing's totals, not a person.

Address windows add a longer-lived per-address cost on top of the 60-second edge burst
limits. Defaults are 1 heart per plugin per day, 1 copy per plugin per hour, and 5 views
per plugin per hour, plus coarser hourly and daily caps across plugins. IPv6 addresses
in the same /64 share a quota. Missing or unusable `CF-Connecting-IP` values are rejected.
These windows live in the edge cache, can be evicted or split across locations, and are
not unique identity.

Public stats are cached at the edge for up to five minutes, while browser storage is
disabled and successful event responses return authoritative fresh counts for immediate
UI feedback.

Anonymous public counters remain inflatable by repeating requests or rotating network
addresses. Browser guards and rate limits are best-effort controls that can be cleared,
distributed, or bypassed. Hearts must be presented as anonymous reactions, never as
unique or verified votes, trust, or quality rankings.
