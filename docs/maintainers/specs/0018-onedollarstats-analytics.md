# OneDollarStats analytics

Sites that use OneDollarStats instead of Google Analytics can connect a
OneDollarStats site to a project. The dashboard, the chat, and the MCP tools
then read its organic traffic the way they read a GA4 property.

## How it works

A OneDollarStats API key is saved once per organization, owned by whoever last
entered it. Each project then points at one site hostname, so an account with
many sites enters the key once. Entering a key again replaces the stored one.
OneDollarStats' stats API is a single read endpoint keyed by `site_id` (the
hostname) with `x-api-key` authentication, so there is no OAuth flow, no
per-server URL, and no website listing to secure.

The key is encrypted with the deployment's `BETTER_AUTH_SECRET`, the same key
that encrypts the Google OAuth tokens. It is decrypted in memory for a request
and never returned to the client or an MCP caller. A connection is checked
before it is stored: OpenSEO runs a one-week visitors query, and a failure is
shown next to the form. OneDollarStats has no endpoint that lists a key's
sites, so the hostname is entered by hand and validated by that probe query.

OneDollarStats buckets days in the site's own reporting time zone, which the
API neither reports nor accepts as a parameter. The browser's zone is saved
with the connection as the best available approximation, and reports default
to the last 28 complete days in that zone, like the GA4 reports.

OneDollarStats classifies every visit into a channel, so organic traffic uses
its **Organic Search** channel as a query filter. Totals, entry pages, sources
and the trend all use the same filter, and the numbers match the OneDollarStats
dashboard. Pageviews per page are read across all traffic, because the channel
filter is visit-scoped and pageviews under it would count only landing hits.

The client validates responses with Zod and maps failures to typed errors
(key rejected, rate limited, unreachable, malformed) that never carry the key
or response bodies. Bounce rate is normalized to a 0-1 ratio. Trends over more
than 180 days are requested monthly, matching the GA4 reports' behavior.

## Surfaces

- **Settings → Integrations** has a OneDollarStats card: connect a site,
  change it, or disconnect the project.
- **Dashboard**: an Organic traffic card with visits, visitors, pageviews and
  bounce rate against the previous 28 days, and a daily visits trend. When a
  project uses OneDollarStats and has no GA4 connection, the GA4 connect card
  is hidden.
- **MCP and chat**: `get_onedollarstats_organic_overview`,
  `get_onedollarstats_landing_pages`, `get_onedollarstats_page_performance`
  and `get_onedollarstats_traffic_sources`. They return the same ok/error
  envelope as the GA4 tools, default to organic search, and take
  `channel: "all"` for every visit.

## Alternatives

Making the GA4 tools source-agnostic would give agents one set of analytics
tools. GA4 and OneDollarStats measure different things (sessions, key events
and revenue against visits, visitors and bounce rate), so a shared schema would
either hide fields or invent them. Separate tools with the same envelope keep
each source honest.

Storing the key per project would be simpler, but one OneDollarStats account
covers many sites, and agencies would re-enter and rotate the same key in every
project.

Joining OneDollarStats entry pages with Search Console pages into scored
opportunities, as `get_search_opportunities` does for GA4, is left for later.
