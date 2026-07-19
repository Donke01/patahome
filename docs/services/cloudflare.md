# Cloudflare — DNS + reverse proxy

Sits in front of patahome.co.ke. Handles TLS, caching, DDoS protection, and
serves as the public HTTPS entry point that forwards to Railway.

- Dashboard: https://dash.cloudflare.com
- Zone: `patahome.co.ke`

## DNS records

| Type  | Name  | Value                                    | Proxy |
|-------|-------|------------------------------------------|-------|
| CNAME | @     | `<railway-project>.up.railway.app`       | ON    |
| CNAME | www   | `patahome.co.ke`                         | ON    |

The orange proxy cloud must be **ON** for the domain to get Cloudflare's TLS
cert. If it's grey, browsers see a Railway cert with the wrong host name.

Custom domain must also be added on the Railway side: Service → Settings →
**Domains** → add `patahome.co.ke` and `www.patahome.co.ke`.

## SSL/TLS settings

- Mode: **Full (strict)**
- Always Use HTTPS: **On**
- Automatic HTTPS Rewrites: **On**

## Critical gotcha — 5xx masking

Cloudflare replaces ANY 5xx response from the origin with its own generic
"Something went wrong" error page. That means users never see the JSON error
body we returned from `/api/*` if we send 502 or 503.

**Rule:** all user-facing API errors return 400 (validation) or 401 (auth).
Reserve 5xx for actual server crashes. This is baked into every handler in
`server.js` — do not "fix" a 502 by returning 502 with a better message.

## robots.txt / SEO

Our `server.js` serves a custom `robots.txt` that Allows the read-only
endpoints Googlebot needs to render pages with real data:

```
Allow: /api/areas
Allow: /api/listings
Allow: /api/config
Allow: /api/insights
Disallow: /api/
```

If Search Console flags "Page resources blocked", check that this block is
still present — it lives inside the request handler in `server.js`, not a
static file.

## Cache

We don't rely on Cloudflare caching for HTML — the auth-gated dashboards
would break. Default page rules are fine; do not add aggressive cache rules
without excluding `/api/*` and any signed-in HTML.
