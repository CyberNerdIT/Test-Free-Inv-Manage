# The Tech Garage community registry

`nodes.json` is the list of shops. That's it — the whole directory is a file in
this repository.

## Why a repo instead of a server

The shop list and the stock are two different problems, and they want different
homes:

|  | Shop list | Listings |
|---|---|---|
| Changes | when someone joins | every sale, every price edit |
| Size | small | unbounded |
| Lives in | **this file** | **each shop's own server** |

So the repo answers *who exists*, and every shop answers for its own inventory
at `/api/directory/listings`. Nobody's stock sits on anyone else's machine, and
a price change needs no commit anywhere.

What that buys:

- **No hosting.** Nothing to pay for, keep up, or trust with your data.
- **Auditable.** Every shop that was ever added is a reviewable diff with a name
  attached.
- **Spam control that works.** A human merges the pull request. No heuristic
  beats that.

## What it costs — read this before joining

- **Joining takes a review**, not seconds. Someone has to merge your PR.
- **Your entry is public and permanent.** This is a public git repository, so
  your shop name, URL and coarse region enter its history. Deleting your entry
  removes it from the current file, *not* from past commits. Don't submit
  anything you'd mind being on the internet indefinitely.
- **A neighbour being offline** means their items are missing from your strip.
  That's fine — it degrades quietly.
- **This file scales to a few thousand shops.** Past that it would need
  splitting by country. It is nowhere near that.

If any of that doesn't suit you, run your own directory instead:
`node tools/directory-server.js`, then set *Directory server* mode in the admin
page. Your shops federate with each other and nothing touches this repo.

## Joining

1. In your shop: **Admin → Community directory**. Set your region, enable the
   directory, and press **Copy registry entry**.
2. Make sure `https://your-shop/api/directory/verify` returns your node id in a
   browser. If it doesn't, the entry will be rejected — the check exists so
   nobody can register a URL they don't control.
3. Open an issue with the *Add my shop* template, or send a pull request adding
   your block to the `nodes` array.

CI validates the schema and looks for duplicates on every change, and on pull
requests it also fetches each shop's `/api/directory/verify` to confirm
ownership.

## The entry

```json
{
  "node": "MCowBQYDK2VwAyEA…",
  "name": "Ann's Tech Garage",
  "tagline": "Refurbished laptops, fair prices",
  "url": "https://shop.example",
  "region": { "country": "US", "state": "NY", "area": "Brooklyn" },
  "categories": ["laptop", "ram"],
  "contact": "hello@shop.example",
  "added": "2026-08-04"
}
```

`node` is your shop's Ed25519 public key. It's what proves a listing came from
you, and it's why the entry can't be forged: the URL has to answer with the same
key. `region` is deliberately coarse — country, state, town — because "roughly
near me?" doesn't require knowing where your garage is. `contact` is optional.

## Leaving

Open a PR removing your entry. Shops re-read the registry hourly, so you'll drop
out of their strips within the hour. Your listings were never stored here in the
first place — only the pointer to your shop.
