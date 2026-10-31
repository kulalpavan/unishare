# UniShare

Share files, folders, and text notes with a single no-login link. **100% peer-to-peer** — files stream directly from the sender's browser to the receiver's over WebRTC. There is no database and no file storage: the server only introduces the two browsers (WebSocket signaling) and serves the page.

- Plain HTML/CSS/vanilla JS frontend, no build step
- Node.js + Express static server + WebSocket signaling hub (`/live`)
- No database, no storage, no accounts — nothing is uploaded anywhere
- Text preview, file/folder listing, direct per-file downloads
- Folder shares stay a folder: downloads are re-zipped in the receiver's browser, preserving the folder structure
- Optional password protection (SHA-256 hash comparison — plaintext passwords never leave the browser)
- Optional expiry (minutes / hours / days) — the room closes when it lapses
- The sender **must keep the tab open** until the receiver finishes downloading; closing the tab ends the share. If the connection drops briefly, both sides reconnect automatically and the transfer survives.
- The sender's page shows live status: receiver connected, per-file progress, and a confirmation when a receiver has downloaded everything
- Ephemeral chat: while the share is open, the sender and receiver can message each other over the same WebRTC data channel. Messages are kept only in the open tabs' memory and are never stored on the server or on disk — closing a tab erases them
- Signaling is capped and rate-limited (message size caps, per-socket rate limits, room and listing-memory limits) so one client can't exhaust the free server
- Text notes are downloadable (as `note.txt`, included in folder zips too); folders can be dropped anywhere on the page, including several folders at once

## How it works

1. The sender picks files, a folder, or types a text note, optionally sets a password and expiry, and creates a link. The sender's tab registers as the live sender for that share id.
2. The receiver opens the link. The page joins the signaling room (password hash checked server-side), then connects directly to the sender's browser over WebRTC.
3. Files stream in 16 KB chunks over a WebRTC data channel; folders are re-zipped in the receiver's browser (JSZip, vendored locally, with per-file downloads as fallback). Large manifests and long notes are split into small messages so they fit the data channel's limits.
4. When the download finishes, the receiver notifies the sender, whose page shows a confirmation. Expired shares stay expired: the id can't be re-registered.
5. While the share is open, either side can send chat messages over the same data channel — sender to all connected receivers, receivers to the sender. Nothing is stored; the chat dies with the tabs.
6. If the sender closes the tab first, the link stops working immediately.

## Local setup

Requires Node.js 22+.

```sh
npm install
npm start
```

Then open http://localhost:3000.

## Tests

```sh
npm run verify        # all suites: signaling hub, chunking, reconnects
```

Covers the signaling hub without any database: sender registration, password-hash join verification, signal relay both ways, transfer-complete notification, unknown/expired/dead rooms, sender-disconnect notification, oversized-message survival, rate limiting, room/listing caps, and expiry tombstones (expired ids can't be re-registered). The chunking suite drives the real transfer code with stubbed sockets/peers: an 8000-file manifest, a 340KB note, and per-file failures that leave the session alive. The reconnect suite proves senders re-register after a drop, receivers retry early joins, and signaling drops after the data channel opens are ignored.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ICE_SERVERS` | Google STUN | JSON array of WebRTC ICE servers (see below) |

ICE servers are configured with the `ICE_SERVERS` env var (JSON array); the default is Google's free public STUN server plus the Open Relay Project's free shared TURN servers on every transport (UDP, TCP on ports 80/443, and TLS on 443), so direct connections work behind symmetric NATs (common on mobile networks) and on networks that block UDP too. If a direct connection fails once, the receiver automatically retries with a fresh connection before showing an error. The default TURN credentials are the project's published shared demo credentials — get your own free ones for heavy use. See `.env.example`.

## Deploy to Render

The included `render.yaml` creates a single Free web service — no database, no external storage account.

1. Push to GitHub.
2. In Render, choose **New > Blueprint** and select the repository.
3. Approve and deploy.

Free-tier notes: the signaling service sleeps after inactivity (roughly one-minute cold starts); the share itself needs the sender's tab open, so cold starts only delay the first connection.

## API

- `GET /api/health` — `{ ok, mode: 'p2p', liveRooms }`
- `GET /api/ice` — configured ICE servers
- `GET /s/:id` — share page
- `WS /live` — signaling: `register-sender`, `join`, `signal`, `transfer-complete`

## Security notes

- Share IDs are 16 random bytes (128 bits), base64url-encoded — hard to guess.
- Passwords are stored only as SHA-256 hashes in the ephemeral room; verification compares hashes with a timing-safe comparison. Plaintext passwords never leave the browser that typed them.
- Rooms are in-memory only and wiped when the sender disconnects, when they expire, or after 24 hours at most.
- Path traversal is impossible: the receiver only ever receives the exact relative paths the sender picked.
