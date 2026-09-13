# Trip Advice

This directory is the canonical source for the standalone `trip-advice` TREK
plugin. Keeping it here makes the host integration test reproducible. It is
not a built-in feature and is not installed or enabled by checking out TREK.

Cities, days, and eligible places come from the trip automatically. The owner
can hide exceptions, review a private preview, and create an advice link.
New eligible trip items appear automatically unless hidden. Guests can vote,
comment, and suggest places. Feedback
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
Activation does not publish a trip. Creating a link requires an explicit owner
action and a successful preview. The owner can copy or pause the link here.

The plugin has no direct provider network access. Live Google Places requires
host configuration, approved policy URLs, and an approved spending limit.
Private preview does not save guest feedback or make Google requests.

## Feedback retention

The host queues automatic feedback deletion 90 days after a link expires or
is paused. Saving an already paused link does not extend that deadline.
The host checks at startup and every minute. If the plugin is unavailable,
the durable cleanup queue retries when it returns. Reopening an overdue link
does not bypass pending cleanup. Explicit link deletion and guest-requested
erasure do not wait for the retention window.

## Google Places spending limit

`TREK_PUBLIC_ADVICE_GOOGLE_BUDGET_CENTS` sets the instance-wide monthly limit
in USD cents. Set `500` for an approved US$5 limit. This does not enable Google
Places or approve the policy URLs.

Before each request, the host reserves a conservative whole-cent cost:
autocomplete costs 1 cent, details cost 2 cents, and a photo costs 1 cent.
These ceilings exceed the corresponding undiscounted
[Google list prices](https://developers.google.com/maps/billing-and-pricing/pricing)
checked on 13 September 2026. Free tiers and session discounts do not increase
the allowance. Failed requests still count.

All shares use one durable counter. Reservations and daily request limits run
in the same database transaction. The host retains the full UTC calendar month
and rejects requests that would exceed the limit before contacting Google.
Restarting the host or changing a share does not reset spending.

This controls Trip Advice requests, not other uses of the Google project,
taxes, or exchange rates. Before enabling Google, verify the billed SKUs,
current prices, provider quotas, and approved public policies. Keep cost
ceilings at least as high as every price charged during the current month.
Do not enable this release mid-month after unrecorded usage: the older host
kept only two days of counters.

License: MIT
