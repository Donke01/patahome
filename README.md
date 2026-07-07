# PataHome API

Backend for PataHome — homes, land & vehicles marketplace with location-based discovery.

**Zero dependencies** — uses Node's built-in `node:sqlite`, `node:http`, and `node:crypto`. Requires **Node 22.5+**. No `npm install` needed.

## Quick start

```bash
node seed.js     # creates patahome.db with 18 areas, 8 demo owners, 35 listings
node server.js   # http://localhost:3000
```

Demo owner login: phone `0712445210`, password `demo1234`.

The server also serves static files from `./public` — `public/index.html` is the PataHome frontend, so opening http://localhost:3000 gives you the full site.

## Endpoints

Auth (returns a JWT — send as `Authorization: Bearer <token>`):

- `POST /api/auth/register` — `{name, phone, email?, password}`
- `POST /api/auth/login` — `{phone, password}`
- `GET /api/auth/me`

Listings:

- `GET /api/listings` — filters: `category`, `county`, `minPrice`, `maxPrice`, `bedrooms` (or `3+`), `q`, `lat`+`lng` (adds `distanceKm`, defaults sort to nearest), `radiusKm`, `sort` (`distance|price-asc|price-desc|newest`), `page`, `perPage`. Featured listings always rank first.
- `GET /api/listings/:id`
- `POST /api/listings` (auth) — `{category, title, description?, areaId, price, bedrooms?}`
- `PATCH /api/listings/:id` (owner) — update `title/description/price/bedrooms/status`
- `DELETE /api/listings/:id` (owner) — soft-delete
- `POST /api/listings/:id/contact` — records a lead, returns owner name+phone
- `POST /api/listings/:id/feature` (owner) — `{plan: "feature_7d"|"feature_30d"}`, mock M-Pesa

Location insights:

- `GET /api/insights?lat=&lng=&radiusKm=10` — nearby counts, avg/cheapest rent

Other:

- `GET /api/areas` · `GET /api/favorites` (auth) · `PUT/DELETE /api/favorites/:listingId` (auth)
- `GET /api/my/listings` (auth) — owner dashboard with lead counts
- `GET /api/health`

## Test suite

23 end-to-end tests covering auth, filtering, geo queries, permissions, leads, favorites, and payments all pass. Re-run: start the server, then exercise endpoints with curl.

## Production notes

- Set `JWT_SECRET` and `DB_PATH` env vars.
- Swap the mock payment in `/feature` for M-Pesa Daraja STK push + callback webhook.
- SQLite is fine to thousands of listings; migrate to Postgres when needed.
- Add rate limiting and HTTPS via a reverse proxy (Caddy/nginx) before going live.
- Free/cheap hosting options: Railway, Render, Fly.io, or a KES ~500/mo VPS.
