# Trip Advice

This directory is the canonical source for the standalone `trip-advice` TREK
plugin. Keeping it here makes the host integration test reproducible. It is
not a built-in feature and is not installed or enabled by checking out TREK.

The owner selects public trip items, reviews a private guest preview, and
publishes an advice link. Guests can vote, comment, and suggest places. Feedback
stays in the plugin database. TREK owns authorization, public projections,
Google requests, and imports into the native shortlist.

## Verify and package

Use Node.js 24 or newer. Run checks through `rtest` on the Mac. From this directory:

```sh
pnpm test
pnpm preflight
pnpm run pack
```

The packer writes `dist/trip-advice-<version>.zip` from an explicit runtime
allowlist. Upload that archive through TREK's plugin administration screen.
Activation does not publish a trip. Publishing requires an owner-selected
configuration and a successful preview.

The plugin has no direct provider network access. Live Google Places requires
host configuration, approved policy URLs, and an approved spending limit.
Private preview does not save guest feedback or make Google requests.

License: MIT
