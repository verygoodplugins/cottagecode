# Public sample village

The shareable village runs at **https://autojack.ai/cottagecode/**. It uses
Cloudflare Workers Static Assets so one path can coexist with the domain's
existing redirect. The regular local app continues to run with `npm start`.

## Build and publish

```bash
npm run build:demo
npm run deploy:demo -- --dry-run
npm run deploy:demo
```

Publishing requires an existing authenticated Wrangler installation. The
deployment has no runtime secrets, database bindings, or Node server. Its
configuration is in `wrangler.demo.jsonc`; the deployment manifest is
`cloudflare-commerce.json`.

The build copies only the browser module graph and generated HTML into
`dist/`. It locks the page to fictional demo agents, removes the connection
controls, and ignores feed URL parameters. Browser network connections are
disabled by Content Security Policy. Practice replies affect only the sample
resident in that browser. Live transcripts, activity endpoints, message
routes, receipt ledgers, local history, and backend modules are not shipped.

To build for a different host's root, use:

```bash
node scripts/build-demo.mjs --base /
```

Serve that output using a static host with a real 404 response for missing
files; do not enable SPA fallbacks for arbitrary paths.

## Existing domain redirect

The domain redirects to `automem.ai` through a Cloudflare dynamic redirect
rule. That rule excludes exactly `/cottagecode` and `/cottagecode/*`. The
Worker routes cover the same paths. All other requests retain the existing
redirect. This exclusion is a one-time zone configuration and is preserved
by subsequent asset deployments.

Cloudflare references: [Static Assets](https://developers.cloudflare.com/workers/static-assets/),
[routes](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[subdirectory hosting](https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/).
