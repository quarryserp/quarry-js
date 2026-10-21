# @quarryserp/client

[![npm version](https://img.shields.io/npm/v/@quarryserp/client)](https://www.npmjs.com/package/@quarryserp/client)
[![CI](https://github.com/quarryserp/quarry-js/actions/workflows/ci.yml/badge.svg)](https://github.com/quarryserp/quarry-js/actions/workflows/ci.yml)

Official TypeScript client for [Quarry](https://quarryserp.com) — Google search results as clean, structured data.

- Zero dependencies; uses the standard `fetch`.
- Runs on Node.js 20+, Bun, Deno and edge runtimes.
- Fully typed results for web, news, videos, images, shopping and places.
- Helpers for async searches, polling, pagination, retries and cancellation.

Full documentation: **https://quarryserp.com/docs**

## Install

```sh
npm install @quarryserp/client
# or: bun add @quarryserp/client · pnpm add @quarryserp/client · yarn add @quarryserp/client
```

Get an API key from your [Quarry dashboard](https://quarryserp.com/app/keys). The free plan includes 100 searches per month.

## Quick start

```ts
import { QuarryClient } from "@quarryserp/client";

const quarry = new QuarryClient({ apiKey: process.env.QUARRY_API_KEY });

const search = await quarry.search({
  query: "how do vaccines work",
  lang: "en",
  country: "us",
});

for (const result of search.results.organic ?? []) {
  console.log(result.rank, result.title, result.url);
}
```

`search()` waits for the result (sync mode). A new search usually takes a few seconds; repeating the same search is served from cache instantly and uses no credits.

## Options

```ts
const quarry = new QuarryClient({
  apiKey: "YOUR_API_KEY",
  baseUrl: "https://api.quarryserp.com", // default
  timeoutMs: 120_000, // per request
  retry: { attempts: 2, backoffMs: 500 }, // retries retryable errors (default: none)
  userAgent: "my-app/1.0",
  fetch: customFetch, // optional
});
```

## Search parameters

| Parameter | Description |
|---|---|
| `query` | Search text. Required unless `cursor` is given. |
| `type` | `"web"` (default), `"news"`, `"videos"`, `"images"`, `"shopping"` or `"places"`. |
| `lang` / `country` | Google language and country codes, e.g. `"en"` / `"us"`. Typed as `GoogleLanguage` and `GoogleCountry`; full lists are exported as `GOOGLE_LANGUAGES` and `GOOGLE_COUNTRIES`. |
| `mode` | `"sync"` (default) or `"async"`. |
| `cache` | `false` forces a fresh search. Default `true`. |
| `cursor` | Continue from `pagination.nextCursor`. |
| `resolveLinks` | `"organic"` (default), `"all"` or `"none"`. |
| `thumbnails` | `false` strips image data to make responses smaller. |

See [Search requests](https://quarryserp.com/docs/search-requests) for details.

## Async searches

```ts
const pending = await quarry.submit({ query: "coffee" }); // returns immediately
const done = await quarry.waitFor(pending, { timeoutMs: 120_000 });

// or in one call
const result = await quarry.searchAndWait({ query: "coffee", mode: "async" });
```

## Result-type helpers

```ts
const news = await quarry.searchNews("electric cars", { lang: "en", country: "gb" });
const videos = await quarry.searchVideos("how to make fried rice");
const images = await quarry.searchImages("eiffel tower");
const products = await quarry.searchShopping("running shoes");
const places = await quarry.searchPlaces("coffee shop berlin");
```

Web searches can also include `aiOverview`, `questions`, `knowledgePanel`, `topStories` and `relatedQueries` when Google shows them.

## Pagination

```ts
for await (const page of quarry.paginate({ query: "coffee" }, { maxPages: 3 })) {
  console.log(page.results.organic?.length);
}
```

## Account and usage

```ts
const account = await quarry.account();
console.log(account);
```

## Errors

All failures throw `QuarryError` with a structured `code`, the HTTP status and whether the request is safe to retry.

```ts
import { QuarryError } from "@quarryserp/client";

try {
  await quarry.search({ query: "coffee" });
} catch (error) {
  if (error instanceof QuarryError) {
    console.error(error.code, error.httpStatus, error.retryable);
    // e.g. RATE_LIMITED, QUOTA_EXCEEDED, UNAUTHORIZED, INVALID_PARAMETER, NETWORK_ERROR
  }
}
```

See [Errors](https://quarryserp.com/docs/errors) and [Rate limits & quotas](https://quarryserp.com/docs/rate-limits).

## Cancellation

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);
await quarry.search({ query: "coffee" }, { signal: controller.signal });
```

## Support

Email support@quarryserp.com. Quarry is independent and not affiliated with Google.

## License

MIT
