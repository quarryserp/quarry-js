// QuarryClient unit tests using a fake fetch (no network).

import { describe, expect, it } from "bun:test";
import {
  createClient,
  QuarryClient,
  QuarryError,
  type SearchParams,
  type V1Search,
} from "../src/index";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

function createMockFetch(
  handler: (req: RecordedRequest, callIndex: number) => Promise<Response> | Response,
) {
  const recorded: RecordedRequest[] = [];
  let callIndex = 0;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const rec: RecordedRequest = {
      url,
      method,
      headers,
      body,
      signal: init?.signal as AbortSignal | undefined,
    };
    recorded.push(rec);

    const signal = init?.signal;
    const fetchPromise = Promise.resolve().then(() => handler(rec, callIndex++));
    if (!signal) return await fetchPromise;

    return await new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason ?? new Error("The operation was aborted"));
      };
      if (signal.aborted) {
        return onAbort();
      }
      signal.addEventListener("abort", onAbort, { once: true });
      fetchPromise
        .then((res) => {
          signal.removeEventListener("abort", onAbort);
          resolve(res);
        })
        .catch((err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
  };
  return { fetchFn: fetchFn as typeof fetch, recorded };
}

function mockCompletedSearch(id = "search_123", query = "kopi"): V1Search {
  return {
    id,
    status: "completed",
    query: { text: query, type: "web", engine: "google" },
    results: {
      organic: [
        {
          rank: 1,
          title: "Kopi Indonesia",
          url: "https://example.com/kopi",
          snippet: "Tentang kopi",
        },
      ],
      questions: [],
      relatedQueries: [],
    },
    pagination: { hasNext: false },
    meta: {
      cached: false,
      createdAt: new Date().toISOString(),
      durationMs: 150,
    },
  };
}

describe("QuarryClient", () => {
  it("URL/query building — standard parameters and cursor-only", async () => {
    const { fetchFn, recorded } = createMockFetch(() =>
      Response.json(mockCompletedSearch()),
    );
    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    // 1. All parameters
    await client.search({
      query: "resep nasi goreng",
      type: "web",
      lang: "id",
      country: "id",
      mode: "sync",
      cache: false,
      resolveLinks: "organic",
    });

    expect(recorded[0]!.method).toBe("GET");
    const u1 = new URL(recorded[0]!.url);
    expect(u1.pathname).toBe("/v1/search");
    expect(u1.searchParams.get("query")).toBe("resep nasi goreng");
    expect(u1.searchParams.get("type")).toBe("web");
    expect(u1.searchParams.get("lang")).toBe("id");
    expect(u1.searchParams.get("country")).toBe("id");
    expect(u1.searchParams.get("mode")).toBe("sync");
    expect(u1.searchParams.get("cache")).toBe("false");
    expect(u1.searchParams.get("resolveLinks")).toBe("organic");
    expect(u1.searchParams.has("cursor")).toBe(false);

    // 2. Cursor-only (replaces query, type, etc.)
    await client.search({
      cursor: "c_opaque_12345",
    });

    expect(recorded[1]!.method).toBe("GET");
    const u2 = new URL(recorded[1]!.url);
    expect(u2.pathname).toBe("/v1/search");
    expect(u2.searchParams.get("cursor")).toBe("c_opaque_12345");
    expect(u2.searchParams.has("query")).toBe(false);
    expect(u2.searchParams.has("type")).toBe(false);
    expect(u2.searchParams.has("lang")).toBe(false);
    expect(u2.searchParams.has("country")).toBe(false);
    expect(u2.searchParams.has("thumbnails")).toBe(false);

    // 3. thumbnails=false is sent with a cursor and by get()
    await client.search({ cursor: "c_opaque_12345", thumbnails: false });
    expect(new URL(recorded[2]!.url).searchParams.get("thumbnails")).toBe("false");
    await client.get("abc", { thumbnails: false });
    expect(new URL(recorded[3]!.url).pathname + new URL(recorded[3]!.url).search).toBe("/v1/searches/abc?thumbnails=false");
  });

  it("sends Bearer, User-Agent and Accept headers", async () => {
    const { fetchFn, recorded } = createMockFetch(() =>
      Response.json(mockCompletedSearch()),
    );
    const client = createClient({
      baseUrl: "http://api.test:3000",
      apiKey: "secret-token-xyz",
      userAgent: "CustomClient/1.0",
      fetch: fetchFn,
    });

    await client.search({ query: "halo" });

    expect(recorded[0]!.headers["authorization"]).toBe("Bearer secret-token-xyz");
    expect(recorded[0]!.headers["user-agent"]).toBe("CustomClient/1.0");
    expect(recorded[0]!.headers["accept"]).toBe("application/json");

    // Without apiKey
    const unauthClient = new QuarryClient({
      baseUrl: "http://api.test:3000",
      fetch: fetchFn,
    });
    await unauthClient.get("id-123");
    expect(recorded[1]!.headers["authorization"]).toBeUndefined();
  });

  it("submit() posts mode: 'async' with the right JSON body", async () => {
    const pendingSearch: V1Search = {
      id: "search_post_async",
      status: "pending",
      query: { text: "gemini cli", type: "news", engine: "google" },
      pollUrl: "/v1/searches/search_post_async",
      retryAfterMs: 50,
      meta: { cached: false, createdAt: new Date().toISOString() },
    };

    const { fetchFn, recorded } = createMockFetch(() => Response.json(pendingSearch));
    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    const result = await client.submit({
      query: "gemini cli",
      type: "news",
      lang: "en",
    });

    expect(result.status).toBe("pending");
    expect(recorded[0]!.method).toBe("POST");
    expect(recorded[0]!.url).toBe("http://api.test:3000/v1/searches");
    expect(recorded[0]!.headers["content-type"]).toBe("application/json");
    expect(recorded[0]!.body).toEqual({
      query: "gemini cli",
      type: "news",
      lang: "en",
      mode: "async",
    });
  });

  it("waitFor polling follows retryAfterMs and pollUrl", async () => {
    let polls = 0;
    const { fetchFn, recorded } = createMockFetch((req) => {
      polls++;
      if (polls === 1) {
        // Initial GET /v1/searches/poll_1
        return Response.json({
          id: "poll_1",
          status: "pending",
          query: { text: "poll test", type: "web", engine: "google" },
          pollUrl: "/v1/searches/poll_1",
          retryAfterMs: 20, // short delay to keep the test fast
          meta: { cached: false, createdAt: new Date().toISOString() },
        } satisfies V1Search);
      }
      if (polls === 2) {
        // First poll is still pending
        return Response.json({
          id: "poll_1",
          status: "pending",
          query: { text: "poll test", type: "web", engine: "google" },
          pollUrl: "/v1/searches/poll_1",
          retryAfterMs: 15,
          meta: { cached: false, createdAt: new Date().toISOString() },
        } satisfies V1Search);
      }
      // Second poll completes
      return Response.json(mockCompletedSearch("poll_1", "poll test"));
    });

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });
    const startTime = Date.now();
    const finalSearch = await client.waitFor("poll_1");
    const elapsed = Date.now() - startTime;

    expect(finalSearch.status).toBe("completed");
    expect(polls).toBe(3);
    expect(recorded.length).toBe(3);
    expect(recorded[1]!.url).toBe("http://api.test:3000/v1/searches/poll_1");
    expect(recorded[2]!.url).toBe("http://api.test:3000/v1/searches/poll_1");
    // Waited at least 20ms + 15ms = 35ms
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it("waitFor returns immediately for a completed search", async () => {
    let called = false;
    const { fetchFn } = createMockFetch(() => {
      called = true;
      return Response.json({});
    });
    const client = new QuarryClient({ fetch: fetchFn });

    const completed = mockCompletedSearch();
    const res = await client.waitFor(completed);
    expect(res).toBe(completed);
    expect(called).toBe(false);
  });

  it("paginate stops without nextCursor and respects maxPages", async () => {
    const page1: V1Search = {
      ...mockCompletedSearch("p1", "page query"),
      pagination: { hasNext: true, nextCursor: "cursor_page_2" },
    };
    const page2: V1Search = {
      ...mockCompletedSearch("p2", "page query"),
      pagination: { hasNext: true, nextCursor: "cursor_page_3" },
    };
    const page3: V1Search = {
      ...mockCompletedSearch("p3", "page query"),
      pagination: { hasNext: false },
    };

    // 1. Fetch every page until there is no nextCursor
    const { fetchFn: fetch1, recorded: rec1 } = createMockFetch((req) => {
      const u = new URL(req.url);
      const cursor = u.searchParams.get("cursor");
      if (cursor === "cursor_page_2") return Response.json(page2);
      if (cursor === "cursor_page_3") return Response.json(page3);
      return Response.json(page1);
    });

    const client1 = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetch1 });
    const collected1: V1Search[] = [];
    for await (const page of client1.paginate({ query: "page query" })) {
      collected1.push(page);
    }

    expect(collected1.length).toBe(3);
    expect(collected1[0]!.id).toBe("p1");
    expect(collected1[1]!.id).toBe("p2");
    expect(collected1[2]!.id).toBe("p3");
    // Pages 2 and 3 send only the cursor
    expect(new URL(rec1[1]!.url).search).toBe("?cursor=cursor_page_2");
    expect(new URL(rec1[2]!.url).search).toBe("?cursor=cursor_page_3");

    // 2. Respects maxPages = 2
    const { fetchFn: fetch2 } = createMockFetch((req) => {
      const u = new URL(req.url);
      const cursor = u.searchParams.get("cursor");
      if (cursor === "cursor_page_2") return Response.json(page2);
      return Response.json(page1);
    });

    const client2 = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetch2 });
    const collected2: V1Search[] = [];
    for await (const page of client2.paginate({ query: "page query" }, { maxPages: 2 })) {
      collected2.push(page);
    }

    expect(collected2.length).toBe(2);
    expect(collected2[0]!.id).toBe("p1");
    expect(collected2[1]!.id).toBe("p2");
  });

  it("maps 401 to UNAUTHORIZED", async () => {
    const { fetchFn } = createMockFetch(() =>
      Response.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid API key.", retryable: false } },
        { status: 401 },
      ),
    );
    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    try {
      await client.search({ query: "test" });
      expect(true).toBe(false); // must not be reached
    } catch (err) {
      expect(err instanceof QuarryError).toBe(true);
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("UNAUTHORIZED");
      expect(gErr.httpStatus).toBe(401);
      expect(gErr.retryable).toBe(false);
      expect(gErr.message).toBe("Invalid API key.");
    }
  });

  it("maps a failed search to QuarryError with the search attached", async () => {
    const failedSearch: V1Search = {
      id: "search_failed_captcha",
      status: "failed",
      query: { text: "blocked query", type: "web", engine: "google" },
      error: {
        code: "BLOCKED_BY_CAPTCHA",
        message: "Google menyajikan CAPTCHA",
        retryable: true,
      },
      meta: {
        cached: false,
        createdAt: new Date().toISOString(),
      },
    };

    const { fetchFn } = createMockFetch(() =>
      Response.json(failedSearch, { status: 503 }),
    );
    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    try {
      await client.search({ query: "blocked query" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof QuarryError).toBe(true);
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("BLOCKED_BY_CAPTCHA");
      expect(gErr.httpStatus).toBe(503);
      expect(gErr.retryable).toBe(true);
      expect(gErr.search).toBeDefined();
      expect(gErr.search?.id).toBe("search_failed_captcha");
      expect(gErr.search?.status).toBe("failed");
    }
  });

  it("a timeout throws a retryable NETWORK_ERROR", async () => {
    const { fetchFn } = createMockFetch(async (_req) => {
      // Wait longer than the client timeout (100ms)
      await new Promise((r) => setTimeout(r, 200));
      return Response.json(mockCompletedSearch());
    });

    const client = new QuarryClient({
      baseUrl: "http://api.test:3000",
      timeoutMs: 30, // 30ms timeout
      fetch: fetchFn,
    });

    try {
      await client.search({ query: "slow" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof QuarryError).toBe(true);
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("NETWORK_ERROR");
      expect(gErr.retryable).toBe(true);
      expect(gErr.message).toContain("Request timed out");
    }
  });

  it("retries a retryable error and then succeeds", async () => {
    let attempts = 0;
    const { fetchFn } = createMockFetch(() => {
      attempts++;
      if (attempts === 1) {
        // Fails with 503 BLOCKED_BY_CAPTCHA (retryable)
        return Response.json(
          { error: { code: "BLOCKED_BY_CAPTCHA", message: "Server sibuk", retryable: true } },
          { status: 503 },
        );
      }
      return Response.json(mockCompletedSearch("retry_success"));
    });

    const client = new QuarryClient({
      baseUrl: "http://api.test:3000",
      retry: { attempts: 2, backoffMs: 10 },
      fetch: fetchFn,
    });

    const result = await client.search({ query: "retry test" });
    expect(result.id).toBe("retry_success");
    expect(attempts).toBe(2);
  });

  it("does not retry non-retryable errors (e.g. 400 INVALID_PARAMETER)", async () => {
    let attempts = 0;
    const { fetchFn } = createMockFetch(() => {
      attempts++;
      return Response.json(
        { error: { code: "INVALID_PARAMETER", message: "Bad parameter", retryable: false } },
        { status: 400 },
      );
    });

    const client = new QuarryClient({
      baseUrl: "http://api.test:3000",
      retry: { attempts: 3, backoffMs: 10 },
      fetch: fetchFn,
    });

    try {
      await client.search({ query: "" });
      expect(true).toBe(false);
    } catch (err) {
      expect(attempts).toBe(1); // no retry
      expect((err as QuarryError).code).toBe("INVALID_PARAMETER");
    }
  });

  it("html() returns raw HTML from GET /v1/searches/{id}/html", async () => {
    const rawHtml = "<!doctype html><html><head><title>Google</title></head><body>Hasil</body></html>";
    const { fetchFn, recorded } = createMockFetch(() =>
      new Response(rawHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });
    const content = await client.html("html_id_1");

    expect(content).toBe(rawHtml);
    expect(recorded[0]!.url).toBe("http://api.test:3000/v1/searches/html_id_1/html");
    expect(recorded[0]!.headers["accept"]).toBe("text/html");
  });

  it("searchAndWait() keeps polling while pending", async () => {
    let calls = 0;
    const { fetchFn } = createMockFetch(() => {
      calls++;
      if (calls === 1) {
        // GET /v1/search answers pending (e.g. server sync timeout)
        return Response.json({
          id: "sync_timeout_id",
          status: "pending",
          query: { text: "sync timeout query", type: "web", engine: "google" },
          pollUrl: "/v1/searches/sync_timeout_id",
          retryAfterMs: 10,
          meta: { cached: false, createdAt: new Date().toISOString() },
        } satisfies V1Search);
      }
      return Response.json(mockCompletedSearch("sync_timeout_id", "sync timeout query"));
    });

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });
    const result = await client.searchAndWait({ query: "sync timeout query" });

    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
  });

  it("aborting with an external AbortSignal throws NETWORK_ERROR", async () => {
    const controller = new AbortController();
    const { fetchFn } = createMockFetch(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return Response.json(mockCompletedSearch());
    });

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    setTimeout(() => {
      controller.abort("Cancelled by user");
    }, 20);

    try {
      await client.search({ query: "abort test" }, { signal: controller.signal });
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof QuarryError).toBe(true);
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("NETWORK_ERROR");
      expect(gErr.retryable).toBe(false);
      expect(gErr.message).toContain("Cancelled by user");
    }
  });

  it("a network failure (fetch throws TypeError) is a retryable NETWORK_ERROR", async () => {
    const { fetchFn } = createMockFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    try {
      await client.search({ query: "network fail" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof QuarryError).toBe(true);
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("NETWORK_ERROR");
      expect(gErr.retryable).toBe(true);
      expect(gErr.message).toContain("Failed to fetch");
    }
  });

  it("maps 404 to NOT_FOUND and 500 to INTERNAL_ERROR", async () => {
    let mode: "404" | "500" = "404";
    const { fetchFn } = createMockFetch(() => {
      if (mode === "404") {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Search not found.", retryable: false } },
          { status: 404 },
        );
      }
      return Response.json(
        { error: { code: "INTERNAL_ERROR", message: "Database down.", retryable: true } },
        { status: 500 },
      );
    });

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    // 404
    try {
      await client.get("unknown_id");
      expect(true).toBe(false);
    } catch (err) {
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("NOT_FOUND");
      expect(gErr.httpStatus).toBe(404);
      expect(gErr.retryable).toBe(false);
    }

    // 500
    mode = "500";
    try {
      await client.get("broken_id");
      expect(true).toBe(false);
    } catch (err) {
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("INTERNAL_ERROR");
      expect(gErr.httpStatus).toBe(500);
      expect(gErr.retryable).toBe(true);
    }
  });

  it("waitFor() timeout throws NETWORK_ERROR", async () => {
    const { fetchFn } = createMockFetch(() => {
      return Response.json({
        id: "poll_infinite",
        status: "pending",
        query: { text: "infinite", type: "web", engine: "google" },
        retryAfterMs: 30,
        meta: { cached: false, createdAt: new Date().toISOString() },
      } satisfies V1Search);
    });

    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });

    try {
      await client.waitFor("poll_infinite", { timeoutMs: 50 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof QuarryError).toBe(true);
      const gErr = err as QuarryError;
      expect(gErr.code).toBe("NETWORK_ERROR");
      expect(gErr.retryable).toBe(true);
      expect(gErr.message).toContain("waitFor timed out");
    }
  });

  it("strips a trailing slash from baseUrl", async () => {
    const { fetchFn, recorded } = createMockFetch(() => Response.json(mockCompletedSearch()));
    const client = new QuarryClient({
      baseUrl: "http://api.test:3000///",
      fetch: fetchFn,
    });

    await client.get("id_test");
    expect(recorded[0]!.url).toBe("http://api.test:3000/v1/searches/id_test");
  });
});

describe("result-type helpers", () => {
  it("send the right type and return the result list", async () => {
    const results = {
      organic: [], questions: [], relatedQueries: [],
      news: [{ rank: 1, title: "N", url: "https://n.example" }],
      videos: [{ rank: 1, title: "V", url: "https://v.example", duration: "1:00" }],
      images: [{ rank: 1, imageUrl: "https://i.example/a.jpg" }],
      shopping: [{ rank: 1, title: "P", priceText: "Rp 45.000", price: 45000 }],
      places: [{ rank: 1, title: "Kost Tebet 17", rating: 4.9, reviews: 41, category: "Rumah wisata", address: "Jl. Tebet Timur Dalam IXA No.17, RT.13/RW.9", phone: "0821-2228-2048" }],
    };
    const { fetchFn, recorded } = createMockFetch(() => Response.json({ ...mockCompletedSearch(), results }));
    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });
    expect(await client.searchNews("pemilu", { lang: "id" })).toEqual(results.news);
    expect(await client.searchVideos("react")).toEqual(results.videos);
    expect(await client.searchImages("kucing", { thumbnails: false })).toEqual(results.images);
    expect(await client.searchShopping("sepatu")).toEqual(results.shopping);
    expect(await client.searchPlaces("kost tebet", { lang: "id", country: "id" })).toEqual(results.places);
    const params = recorded.map((r) => new URL(r.url).searchParams);
    expect(params.map((p) => p.get("type"))).toEqual(["news", "videos", "images", "shopping", "places"]);
    expect(params[0]!.get("query")).toBe("pemilu");
    expect(params[0]!.get("lang")).toBe("id");
    expect(params[2]!.get("thumbnails")).toBe("false");
    expect(params[4]!.get("query")).toBe("kost tebet");
    expect(params[4]!.get("lang")).toBe("id");
    expect(params[4]!.get("country")).toBe("id");
  });
  it("return an empty list when the type is missing", async () => {
    const { fetchFn } = createMockFetch(() => Response.json(mockCompletedSearch()));
    const client = new QuarryClient({ baseUrl: "http://api.test:3000", fetch: fetchFn });
    expect(await client.searchShopping("apa saja")).toEqual([]);
    expect(await client.searchPlaces("kost tebet")).toEqual([]);
  });
});
