# UniShare

Share files, folders, and text notes with a single no-login link.

- Plain HTML/CSS/vanilla JS frontend, no build step
- Node.js + Express + PostgreSQL for metadata, passwords, and (by default on Render) file bytes
- File storage on local disk for development, PostgreSQL for Render-only free hosting, or Cloudflare R2
- Text preview, file/folder listing, direct per-file downloads
- Folder shares stay a folder: downloads are always a streamed `<Folder>.zip`
  containing `<Folder>/...`, even when the folder holds a single file
- Optional password protection (bcrypt, short-lived signed httpOnly cookie)
- Optional expiry (minutes / hours / days)
- Expired shares are rejected and periodically cleaned up
- Rate limits on uploads and password attempts

## Local setup

Requirements: Node.js 22+ and Docker (for PostgreSQL).

```bash
npm install
npm run db:up
cp .env.example .env
npm start
```

Open http://localhost:3000. On PowerShell use `Copy-Item .env.example .env` instead of `cp`.

## Tests

```bash
npm run verify
```

The suite starts its own server on a free port, uses the `unishare_test`
database from Docker, and exercises text, multi-file, folder, password,
expiry, traversal, and rate-limit-safe flows. It runs against local disk by
default; use `TEST_STORAGE_DRIVER=pg` to exercise PostgreSQL blob storage.
Override the database with `TEST_DATABASE_URL` if needed.

```bash
npm run db:down
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `TEST_DATABASE_URL` | local `unishare_test` | Database used by `npm run verify` |
| `PORT` | `3000` | HTTP port |
| `STORAGE_DRIVER` | `local` (or `r2` if R2 vars exist) | `local`, `pg` (PostgreSQL blobs), or `r2` |
| `UNISHARE_DATA_DIR` | `./data` | Local files, temp uploads, cookie secret |
| `UNISHARE_SECRET` | generated file | Stable HMAC secret for unlock cookies |
| `MAX_FILE_MB` | `200` | Per-file upload limit |
| `MAX_REQUEST_MB` | `500` | Per-request upload limit (all files combined) |
| `PGSSL` | auto from URL | Force PostgreSQL SSL when the provider requires it |
| `R2_ACCOUNT_ID` | — | Cloudflare account ID |
| `R2_BUCKET` | — | Private R2 bucket name |
| `R2_ACCESS_KEY_ID` | — | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | — | R2 API token secret |
| `R2_ENDPOINT` | derived from account ID | Optional custom S3-compatible endpoint |
| `R2_REGION` | `auto` | Optional S3 region override |
| `R2_FORCE_PATH_STYLE` | `false` | Set `true` if your S3 client needs path-style |
| `UPLOAD_RATE_LIMIT` | `30` | Uploads per IP per hour |
| `UNLOCK_RATE_LIMIT` | `10` | Password attempts per IP per 15 minutes |
| `PG_POOL_MAX` | `5` | PostgreSQL pool size |

## Storage modes

- `local` — development only; files live in `UNISHARE_DATA_DIR/shares`.
- `pg` — Render-only mode; file bytes are stored in the `share_files` table.
  No external storage account is needed, but files count toward the 1 GB
  PostgreSQL limit.
- `r2` — optional Cloudflare R2 for larger or longer-lived deployments.

## Cloudflare R2 setup (optional)

1. Create a private R2 bucket (no public access).
2. Create an R2 API token with **Object Read & Write** for that bucket.
3. Copy the account ID, access key ID, secret access key, and bucket name.
4. Test from your machine:

```powershell
$env:STORAGE_DRIVER='r2'
$env:R2_ACCOUNT_ID='...'
$env:R2_BUCKET='unishare'
$env:R2_ACCESS_KEY_ID='...'
$env:R2_SECRET_ACCESS_KEY='...'
npm run verify:r2
```

The app stores objects under `<shareId>/<relative/path>`. The bucket can stay
private; downloads are streamed through the Express server.

## Deploy to Render

The included `render.yaml` creates a Free web service and a Free PostgreSQL
database and needs **no external storage account**. `STORAGE_DRIVER=pg` keeps
metadata and file bytes in the same Render database.

1. Push this folder to a GitHub repository.
2. In Render, choose **New > Blueprint** and select the repository.
3. Approve the plan and deploy. Render generates the database connection
   string and cookie secret automatically.
4. Smoke test with text, file, folder, and password shares.

Render free-tier notes:

- Free PostgreSQL gives you 1 GB total for metadata **and file contents**, and
  the database **expires 30 days after creation**. Upgrade it or switch to an
  external PostgreSQL provider before expiry if you need to keep the data.
- Files uploaded while using `STORAGE_DRIVER=local` would be lost on restart
  because the web filesystem is ephemeral. The blueprint therefore uses `pg`.
- Free web services spin down after inactivity; the first request may take
  about a minute. Upload limits are lowered to 50 MB per file and 100 MB per
  request in the blueprint to fit the free database and memory limits.
- For larger or longer-lived storage, create an R2 bucket and switch
  `STORAGE_DRIVER` to `r2` with the optional environment variables.

## API

| Method | Route                 | Description                                   |
|--------|-----------------------|-----------------------------------------------|
| POST   | `/api/upload`         | multipart: `files[]` + `paths[]`, `kind` (`note`/`files`/`folder`), `text`, `password`, `expiryValue`, `expiryUnit` |
| GET    | `/api/share/:id`      | share metadata / listing (401 if locked, 410 if expired) |
| POST   | `/api/share/:id/unlock` | `{ password }`, sets short-lived signed httpOnly cookie |
| GET    | `/d/:id`              | streaming download of the whole share (ZIP for folders/multi-file) |
| GET    | `/d/:id/file?path=…`  | streaming download of one file inside the share |

## Security notes

- Passwords are stored only as bcrypt hashes; verification happens server-side.
- Unlock cookies are HMAC-signed, HttpOnly, SameSite=Lax, scoped per share,
  and marked `Secure` when `NODE_ENV=production`.
- Share IDs are 16-byte random base64url (128 bits of entropy).
- Uploads and password attempts are rate limited per IP.
- Path traversal is blocked for local, PostgreSQL, and R2 storage keys.
