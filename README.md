# SWGOH Arena Tracker

## Architecture

- GitHub Pages hosts `index.html` only.
- A separate Render Web Service runs `proxy/server.js`.
- `COMLINK_URL` on the proxy points to the separate SWGOH Comlink Render service.

### Important

Set `API_BASE_URL` in `index.html` to the **Arena Tracker proxy URL**, not the Comlink URL.

Set the Render environment variable `COMLINK_URL` to the **Comlink service URL**.

The proxy exposes:

- `GET /health`
- `POST /playerArena`
- `POST /player`
- `POST /characterImage`
- `GET /portraitStatus`
- `GET /gameDataStatus`
- `POST /data`

The browser should never call Comlink directly.
