# mascot

Optional sprite-ready character art for Hubert. Drop transparent PNGs here and the
header shows a small static character next to the mic button for the matching pose.
If a file is missing, nothing is rendered. No roaming, dragging or floating.

Expected files (all optional, transparent background, roughly square, shown at 28px):

- `idle.png`      - nothing else is happening
- `listening.png` - mic is recording
- `thinking.png`  - transcribing or a request is in flight
- `speaking.png`  - a voice answer just landed
- `error.png`     - server stale or a voice error

WebP, GIF and SVG also work (`/mascot/idle.webp` and so on). Files are served by
`server.ts` at `/mascot/<name>`; everything here except this README is gitignored.
