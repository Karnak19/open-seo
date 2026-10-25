# OneDollarStats analytics

Connect a project to a [OneDollarStats](https://onedollarstats.com) site to see
its organic traffic in OpenSEO: the dashboard's Organic traffic card, the chat,
and the MCP tools. The connection is read-only.

## What you'll need

- A OneDollarStats account with the site added.
- An API key from **Account settings → API Keys** in OneDollarStats. The key is
  shown once, so copy it when you create it.
- The site's hostname, exactly as configured in OneDollarStats, for example
  `example.com`.
- On a self-hosted OpenSEO deployment: `BETTER_AUTH_SECRET` set to at least 32
  characters. It encrypts the API key. Hosted OpenSEO already has it.

## Connect a project

1. Open the project's **Settings → Integrations** and find the
   **OneDollarStats** card.
2. Enter the API key and the site's hostname, then select **Connect site**.
   OpenSEO runs a one-week test query first, so a wrong key or hostname is
   rejected next to the form instead of failing later on the dashboard.

The API key is saved for the organization. In another project, the
OneDollarStats card only asks for that project's hostname and reuses the saved
key. Entering a key again replaces the stored one, for example after rotating
it in OneDollarStats.

Days are counted in the time zone of the browser you connected from. To change
it, connect the site again from a browser in the other time zone.

## What OpenSEO reads

| Where                                 | What                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Dashboard, Organic traffic            | Visits, visitors, pageviews and bounce rate from search engines, last 28 complete days. |
| `get_onedollarstats_organic_overview` | The same totals for any date range against the previous period, with a visits trend.    |
| `get_onedollarstats_page_performance` | Pageviews, visitors and visits per page, across all traffic or only search visits.      |
| `get_onedollarstats_traffic_sources`  | Visits by referring domain (with `(direct)` for none) or by UTM source.                 |

Organic traffic means visits referred by a search engine: Google, Bing,
DuckDuckGo, Ecosia, Yandex, Baidu, Yahoo, Qwant, Startpage, Brave, Naver,
Seznam, MSN and their regional subdomains. OpenSEO applies this
classification itself, so it is the same definition across providers; a
visitor who reached the site from two different sources counts once per
source in the organic totals, and utm-tagged search visits are only organic
when the referrer is a search engine too. The MCP tools take `channel: "all"`
for every visit, and the chat uses the same tools. The trend is daily, or
monthly for ranges over 180 days.

## Troubleshooting

- **"OneDollarStats rejected the saved API key"**: the key was revoked or
  rotated. Enter the new one in the OneDollarStats card.
- **"OneDollarStats denied access to this site"**: the key works, but not for
  this hostname. Check that it matches the site in your OneDollarStats account
  exactly, including or excluding `www.` the same way, and reconnect.
- **The card says the saved key can no longer be read**: the deployment's
  `BETTER_AUTH_SECRET` changed. Add the key again.
