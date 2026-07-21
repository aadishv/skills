---
name: publish-markdown
description: Use to take a Markdown document (e.g., implementation plan), render it to HTML, then generate a link you can share to the user to view the rendered Markdown.
---

It's simple! Just call `bash path/to/scripts/cli.sh path/to/file.md`, where the scripts dir is in the same parent dir as this SKILL.md.

## Tailnet publisher

`walkthrough/scripts/server.ts` is a dependency-free Node server intended to run manually on the tailnet host. It stores each uploaded standalone HTML page as `.storage/<uuid>.html` and records its upload time in `.storage/manifest.json`; the CLI posts to `WALKTHROUGH_PUBLISH_URL` from `walkthrough/scripts/.env.local` and prints the returned tailnet-only URL. Run it on the host with `node server.ts`, setting `WALKTHROUGH_PUBLIC_URL` to the URL clients should receive when its hostname differs from its Tailscale IP.
