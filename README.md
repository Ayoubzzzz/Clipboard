# Clipboard

Paste text or a photo on one device and see it on your other devices right away.
No login and no app: open the site on your phone and your computer, enter the same short room code, and paste.

## How it works

- **Frontend:** plain HTML, CSS and JavaScript in `public/`, served as static assets.
- **Backend:** one Cloudflare Worker (`src/worker.js`). Each room code maps to a
  Durable Object that keeps the room's items and relays them over WebSockets to every
  connected device. Idle connections use WebSocket hibernation, so they cost almost nothing.
- **Rooms:** 6-character codes without look-alike characters (no 0/O or 1/I/L). The room
  link is `https://<your-site>/#CODE`, and the room page shows a QR code for it.
- **Expiry:** items are deleted 24 hours after they're pasted. A room keeps at most the 30 newest items.
- **Images:** large photos are shrunk in the browser (longest side 2000 px, JPEG) to stay under 1.5 MB.

Anyone who knows a room code can see that room, so don't paste passwords or secrets.

## Using it

- Tap **Start a new room**, then on the other device type the code or scan the QR code.
- On a computer, press **Ctrl+V** anywhere on the page to send text or a screenshot instantly, or drop images on the box.
- On a phone, use **Paste** (reads your clipboard), **Photo** (camera roll), or type and tap **Send**.
- Each item has **Copy**, **Open** (for links), **Save** (for images) and **Delete**.

## Develop

```sh
npm install
npm run dev        # http://localhost:8787
```

## Deploy

Durable Objects with SQLite storage are included in the Workers free plan.

```sh
npx wrangler login
npm run deploy
```

Wrangler prints the `*.workers.dev` URL. You can add a custom domain in the Cloudflare dashboard.

## Credits

QR codes are drawn with [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT), vendored in `public/vendor/qrcode.js`.
