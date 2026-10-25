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

OneDollarStats reads a date pair as literal UTC instants: a bare date is its
UTC midnight, so an end date sent as `2026-10-24` would cut that day at 00:00.
Ranges are therefore sent as whole UTC days
(`startDateT00:00:00.000Z` through `endDateT23:59:59.999Z`). The API gives no
way to read a site's reporting time zone, so the browser's zone is saved with
the connection and picks which calendar days count as complete, like the GA4
reports; for a site reporting outside UTC the day edges can drift by a few
hours, which is accepted and documented.

The stats API's documentation advertises a `visit:channel` dimension, but the
live API rejects it (as it does `visit:source`), its `visit:entry_page`
dimension errors server-side, and its `matches` filter breaks server-side on
any non-trivial regex (groups, quantifiers — `contains` too). So organic
traffic never filters server-side: queries group by the visit's referrer —
anchored to search-engine domains, the same definition the Umami integration
uses — and the rows are classified here, where a real regex engine exists.
Totals aggregate those rows client-side — counts sum, bounce rate and visit
duration become visit-weighted averages — and visitors sum per source, so a
visitor from two sources counts twice; the API offers no deduplicated organic
total. Page reports add the referrer as a second dimension and aggregate it
away, which counts pageviews per page during search visits rather than entry
pages: there is no working entry-page dimension to do better with. Unfiltered
queries cap at the API's 10 000-row default; reports surface that and their
own `limit` cut through a `truncated` flag instead of offset paging, because
aggregation happens after the fetch.

The client validates responses with Zod — dimension values can be null (a
visit with no referrer reports one; the sources report labels it `(direct)`)
— and maps failures to typed errors (key rejected, site inaccessible, rate
limited, unreachable, malformed) that never carry the key or response bodies.
An invalid key answers 401 and a key without access to the requested site 403,
so a typo'd hostname is caught when connecting rather than reported as zeros.
Bounce rate is normalized to a 0-1 ratio. Trends over more than 180 days are
requested monthly, matching the GA4 reports' behavior.

## Surfaces

- **Settings → Integrations** has a OneDollarStats card: connect a site,
  change it, or disconnect the project.
- **Dashboard**: an Organic traffic card with visits, visitors, pageviews and
  bounce rate against the previous 28 days, and a daily visits trend. When a
  project uses OneDollarStats and has no GA4 connection, the GA4 connect card
  is hidden.
- **MCP and chat**: `get_onedollarstats_organic_overview`,
  `get_onedollarstats_page_performance` and
  `get_onedollarstats_traffic_sources`. They return the same ok/error envelope
  as the GA4 tools, default to organic search, and take `channel: "all"` for
  every visit.

## Alternatives

Making the GA4 tools source-agnostic would give agents one set of analytics
tools. GA4 and OneDollarStats measure different things (sessions, key events
and revenue against visits, visitors and bounce rate), so a shared schema would
either hide fields or invent them. Separate tools with the same envelope keep
each source honest.

Storing the key per project would be simpler, but one OneDollarStats account
covers many sites, and agencies would re-enter and rotate the same key in every
project.

Waiting for OneDollarStats to ship the documented `visit:channel` dimension
would give organic traffic its own classification, but the live API rejects it
today and there is no timeline for it; the referrer regex matches the Umami
integration's definition, so the two providers count organic the same way.

Joining OneDollarStats pages with Search Console pages into scored
opportunities, as `get_search_opportunities` does for GA4, is left for later.
