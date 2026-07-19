# Cloudinary — image + document storage

Stores listing photos and verification documents. Uploads go directly from
the browser to Cloudinary using a signed request — the server never touches
the file bytes, which keeps our Railway disk quota at zero.

- Dashboard: https://cloudinary.com/console
- Docs: https://cloudinary.com/documentation/upload_images

## Env vars

| Variable                | Where to find it                              |
|-------------------------|-----------------------------------------------|
| `CLOUDINARY_CLOUD_NAME` | Dashboard header — the string after "Cloud:"  |
| `CLOUDINARY_API_KEY`    | Dashboard → Settings → API Keys               |
| `CLOUDINARY_API_SECRET` | Dashboard → Settings → API Keys               |

## Folders

Two folders, distinct so we can apply different transformations and moderation
rules:

| Folder               | Contents                                        |
|----------------------|-------------------------------------------------|
| `patahome/listings`  | Public listing photos (JPG/PNG/WebP, ≤ 5 MB)    |
| `patahome/verify`    | KYC docs — ID, ownership proof, selfie          |

`patahome/verify` should be **restricted** so URLs aren't publicly guessable.
Options: Type = `authenticated`, or an access mode rule that requires a
signed URL. Currently listings are `upload` (public) and verify docs are
served via signed URLs from the admin UI.

## Upload flow

1. Browser calls `POST /api/uploads/sign` with `{folder, publicId}`.
2. Server signs a Cloudinary upload params blob with `API_SECRET` (never
   sent to the client) and returns `{signature, timestamp, apiKey, cloud}`.
3. Browser POSTs the file directly to
   `https://api.cloudinary.com/v1_1/<cloud>/image/upload` with those params.
4. Cloudinary returns `{secure_url, public_id}`; browser sends the
   `public_id` back to our API to persist on the listing/user record.

We only store `public_id`, never the full URL — the URL is reconstructed
from `cloud` at read time, so we can swap accounts or CDN prefixes without
touching the DB.

## Limits

Free tier: 25 GB storage + 25 GB monthly bandwidth. Watch the dashboard —
if we approach that, listing photos should be resized on upload
(`transformation: c_limit,w_1600,q_auto`) to cut bytes.
