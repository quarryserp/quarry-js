// Standalone, zero-dependency TypeScript client for the Quarry v1 API.
// Runs on Bun, Node 20+, Deno and edge runtimes using only `fetch`.

import type {
  ClientErrorCode,
  QuarryClientOptions,
  PaginateOptions,
  RequestOptions,
  RetryOptions,
  SearchParams,
  V1ErrorCode,
  V1Account,
  V1Image,
  V1News,
  V1Place,
  V1Product,
  V1Results,
  V1Search,
  V1Video,
  VerticalParams,
  WaitForOptions,
} from "./types.js";

export * from "./types.js";
export * from "./locales.js";

/** Quarry production API URL; override with the `baseUrl` option. */
export const DEFAULT_BASE_URL = "https://api.quarryserp.com";

/**
 * Error thrown by QuarryClient.
 * Carries a structured error code, the HTTP status, whether the request is retryable,
 * and the full V1Search when the server answered with a failed search.
 */
export class QuarryError extends Error {
  readonly code: ClientErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly status?: number;
  readonly search?: V1Search;

  constructor(options: {
    code: ClientErrorCode;
    message: string;
    retryable: boolean;
    httpStatus?: number;
    search?: V1Search;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "QuarryError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.status = options.httpStatus;
    this.search = options.search;
  }
}

/** Maps an HTTP status to a default V1ErrorCode. */
function mapHttpStatusToCode(status: number): V1ErrorCode {
  switch (status) {
    case 400:
      return "INVALID_PARAMETER";
    case 401:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 503:
      return "BLOCKED_BY_CAPTCHA";
    default:
      return "INTERNAL_ERROR";
  }
}

/** Sleep helper that can be cancelled with an AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Operation aborted"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Official client for the Quarry v1 API.
 */
export class QuarryClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly userAgent?: string;
  readonly retry: RetryOptions;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: QuarryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.userAgent = options.userAgent;
    this.retry = {
      attempts: options.retry?.attempts ?? 0,
      backoffMs: options.retry?.backoffMs ?? 500,
    };
    this.fetchImpl = options.fetch;
  }

  /** Returns the fetch implementation in use. */
  private getFetch(): typeof fetch {
    const fn = this.fetchImpl ?? globalThis.fetch;
    if (!fn) {
      throw new Error(
        "No `fetch` available in this runtime. Pass a `fetch` implementation in the QuarryClient options.",
      );
    }
    return fn;
  }

  /**
   * Internal HTTP request with timeout handling, Bearer authentication,
   * error parsing and retries for retryable errors.
   */
  private async executeRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
    acceptHtml = false,
  ): Promise<T> {
    const fullUrl =
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.userAgent) {
      headers["User-Agent"] = this.userAgent;
    }
    if (acceptHtml) {
      headers["Accept"] = "text/html";
    } else {
      headers["Accept"] = "application/json";
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const maxAttempts = options?.retry?.attempts ?? this.retry.attempts ?? 0;
    const backoffMs = options?.retry?.backoffMs ?? this.retry.backoffMs ?? 500;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const fetchFn = this.getFetch();

    let attempt = 0;
    while (true) {
      attempt++;

      const controller = new AbortController();
      let timedOut = false;
      let timerId: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timerId = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Request timeout of ${timeoutMs}ms exceeded`));
        }, timeoutMs);
      }

      const externalSignal = options?.signal;
      let onExternalAbort: (() => void) | undefined;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason);
        } else {
          onExternalAbort = () => controller.abort(externalSignal.reason);
          externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

      try {
        let res: Response;
        try {
          res = await fetchFn(fullUrl, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } catch (fetchErr) {
          // Timeout or network failure
          if (timedOut) {
            throw new QuarryError({
              code: "NETWORK_ERROR",
              message: `Request timed out after ${timeoutMs}ms`,
              retryable: true,
              cause: fetchErr,
            });
          }
          if (externalSignal?.aborted) {
            throw new QuarryError({
              code: "NETWORK_ERROR",
              message:
                externalSignal.reason instanceof Error
                  ? externalSignal.reason.message
                  : typeof externalSignal.reason === "string"
                    ? externalSignal.reason
                    : "Request aborted by the caller",
              retryable: false,
              cause: fetchErr,
            });
          }
          throw new QuarryError({
            code: "NETWORK_ERROR",
            message: fetchErr instanceof Error ? fetchErr.message : "Network error",
            retryable: true,
            cause: fetchErr,
          });
        }

        // Non-success response (HTTP >= 400)
        if (!res.ok) {
          let errorPayload: unknown = null;
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            try {
              errorPayload = await res.json();
            } catch {
              errorPayload = null;
            }
          } else {
            try {
              const text = await res.text();
              try {
                errorPayload = JSON.parse(text);
              } catch {
                errorPayload = text;
              }
            } catch {
              errorPayload = null;
            }
          }

          // Case 1: the body is a full V1Search with status "failed"
          if (
            errorPayload &&
            typeof errorPayload === "object" &&
            (errorPayload as Record<string, unknown>).status === "failed"
          ) {
            const failedSearch = errorPayload as V1Search;
            const code: V1ErrorCode =
              failedSearch.error?.code ??
              (res.status === 503 ? "BLOCKED_BY_CAPTCHA" : mapHttpStatusToCode(res.status));
            const message = failedSearch.error?.message ?? `Search failed with status ${res.status}`;
            const retryable = failedSearch.error?.retryable ?? res.status >= 500;
            throw new QuarryError({
              code,
              message,
              retryable,
              httpStatus: res.status,
              search: failedSearch,
            });
          }

          // Case 2: the standard { error: { code, message, retryable } } body
          if (
            errorPayload &&
            typeof errorPayload === "object" &&
            "error" in errorPayload &&
            typeof (errorPayload as Record<string, unknown>).error === "object"
          ) {
            const errObj = (errorPayload as Record<string, unknown>).error as Record<string, unknown>;
            const code = (errObj.code as V1ErrorCode) ?? mapHttpStatusToCode(res.status);
            const message = (errObj.message as string) ?? `Request failed with status ${res.status}`;
            const retryable =
              typeof errObj.retryable === "boolean" ? errObj.retryable : res.status >= 500;
            throw new QuarryError({
              code,
              message,
              retryable,
              httpStatus: res.status,
            });
          }

          // Case 3: plain text or any other body
          const code = mapHttpStatusToCode(res.status);
          const message =
            typeof errorPayload === "string" && errorPayload.trim()
              ? errorPayload.trim()
              : `Request failed with HTTP status ${res.status}`;
          const retryable = res.status >= 500;
          throw new QuarryError({
            code,
            message,
            retryable,
            httpStatus: res.status,
          });
        }

        // Success (HTTP 2xx)
        if (acceptHtml) {
          const text = await res.text();
          return text as unknown as T;
        }

        const data = (await res.json()) as T;

        // A V1Search may report status "failed" even with HTTP 200
        if (
          data &&
          typeof data === "object" &&
          (data as Record<string, unknown>).status === "failed"
        ) {
          const failedSearch = data as unknown as V1Search;
          throw new QuarryError({
            code: failedSearch.error?.code ?? "INTERNAL_ERROR",
            message: failedSearch.error?.message ?? "Search failed",
            retryable: failedSearch.error?.retryable ?? false,
            httpStatus: res.status,
            search: failedSearch,
          });
        }

        return data;
      } catch (err) {
        // Retry retryable errors
        const isRetryable = err instanceof QuarryError ? err.retryable : false;
        if (isRetryable && attempt <= maxAttempts && !externalSignal?.aborted) {
          const delay = backoffMs * attempt;
          try {
            await sleep(delay, externalSignal);
            continue; // next attempt
          } catch {
            // Aborted during backoff
            throw err;
          }
        }
        throw err;
      } finally {
        if (timerId !== undefined) clearTimeout(timerId);
        if (externalSignal && onExternalAbort) {
          externalSignal.removeEventListener("abort", onExternalAbort);
        }
      }
    }
  }

  /**
   * Runs a search via `GET /v1/search`.
   * Synchronous by default; the result can still be `pending` if the server's
   * wait limit is reached (use `searchAndWait` to keep polling).
   */
  async search(params: SearchParams, options?: RequestOptions): Promise<V1Search> {
    const query = new URLSearchParams();
    if (params.cursor !== undefined) {
      query.set("cursor", params.cursor);
      if (params.mode !== undefined) query.set("mode", params.mode);
      if (params.cache !== undefined) query.set("cache", String(params.cache));
    } else {
      if (params.query !== undefined) query.set("query", params.query);
      if (params.type !== undefined) query.set("type", params.type);
      if (params.lang !== undefined) query.set("lang", params.lang);
      if (params.country !== undefined) query.set("country", params.country);
      if (params.mode !== undefined) query.set("mode", params.mode);
      if (params.cache !== undefined) query.set("cache", String(params.cache));
      if (params.resolveLinks !== undefined) query.set("resolveLinks", params.resolveLinks);
    }
    if (params.thumbnails !== undefined) query.set("thumbnails", String(params.thumbnails));
    if (params.imageFallback !== undefined) query.set("imageFallback", params.imageFallback);
    const qs = query.toString();
    const path = qs ? `/v1/search?${qs}` : "/v1/search";
    return await this.executeRequest<V1Search>("GET", path, undefined, options);
  }

  /**
   * Submits an async search via `POST /v1/searches` (`mode: "async"`).
   * Returns a V1Search, usually with status `pending`.
   */
  async submit(params: SearchParams, options?: RequestOptions): Promise<V1Search> {
    const body: Record<string, unknown> = {
      ...params,
      mode: "async",
    };
    return await this.executeRequest<V1Search>("POST", "/v1/searches", body, options);
  }

  /**
   * Fetches a search result or its status by ID via `GET /v1/searches/{id}`.
   */
  async get(id: string, options?: RequestOptions & { thumbnails?: boolean }): Promise<V1Search> {
    const qs = options?.thumbnails === false ? "?thumbnails=false" : "";
    return await this.executeRequest<V1Search>(
      "GET",
      `/v1/searches/${encodeURIComponent(id)}${qs}`,
      undefined,
      options,
    );
  }

  /**
   * Polls until the search is `completed` or `failed`,
   * following `retryAfterMs` and `pollUrl`.
   */
  async waitFor(
    idOrSearch: string | V1Search,
    options?: WaitForOptions,
  ): Promise<V1Search> {
    let current: V1Search;
    if (typeof idOrSearch === "string") {
      current = await this.get(idOrSearch, options);
    } else {
      current = idOrSearch;
    }

    const startTime = Date.now();
    const totalTimeoutMs = options?.timeoutMs;

    while (current.status === "pending") {
      if (totalTimeoutMs !== undefined && Date.now() - startTime >= totalTimeoutMs) {
        throw new QuarryError({
          code: "NETWORK_ERROR",
          message: `waitFor timed out after ${totalTimeoutMs}ms`,
          retryable: true,
        });
      }

      const waitMs = current.retryAfterMs ?? 1000;
      await sleep(waitMs, options?.signal);

      if (totalTimeoutMs !== undefined && Date.now() - startTime >= totalTimeoutMs) {
        throw new QuarryError({
          code: "NETWORK_ERROR",
          message: `waitFor timed out after ${totalTimeoutMs}ms`,
          retryable: true,
        });
      }

      const path = current.pollUrl ?? `/v1/searches/${encodeURIComponent(current.id)}`;
      current = await this.executeRequest<V1Search>("GET", path, undefined, options);
    }

    if (current.status === "failed") {
      throw new QuarryError({
        code: current.error?.code ?? "INTERNAL_ERROR",
        message: current.error?.message ?? "Search failed",
        retryable: current.error?.retryable ?? false,
        search: current,
      });
    }

    return current;
  }

  /**
   * Runs a search and, if it is still `pending`, keeps polling with `waitFor`
   * until it finishes.
   */
  async searchAndWait(params: SearchParams, options?: WaitForOptions): Promise<V1Search> {
    const result = await this.search(params, options);
    if (result.status === "pending") {
      return await this.waitFor(result, options);
    }
    return result;
  }

  /**
   * Async iterator over result pages, following `pagination.nextCursor`
   * (only the cursor is sent for later pages).
   */
  async *paginate(
    params: SearchParams,
    options?: PaginateOptions,
  ): AsyncGenerator<V1Search, void, unknown> {
    let pagesCount = 0;
    const maxPages = options?.maxPages;
    let currentParams: SearchParams = { ...params };

    while (true) {
      if (maxPages !== undefined && pagesCount >= maxPages) {
        break;
      }

      const page = await this.searchAndWait(currentParams, options);
      yield page;
      pagesCount++;

      if (maxPages !== undefined && pagesCount >= maxPages) {
        break;
      }

      const nextCursor = page.pagination?.nextCursor;
      if (!nextCursor) {
        break;
      }

      // Later pages send only the cursor (plus display options)
      currentParams = { cursor: nextCursor, ...(currentParams.thumbnails !== undefined && { thumbnails: currentParams.thumbnails }) };
    }
  }

  /**
   * Result-type helper: runs `searchAndWait` with the given `type` and returns only that list
   * (empty when there are none). Use `search` / `searchAndWait` when you need `meta` or `pagination`.
   */
  private async vertical<K extends "news" | "videos" | "images" | "shopping" | "places">(
    type: K,
    query: string,
    params: VerticalParams = {},
    options?: WaitForOptions,
  ): Promise<NonNullable<V1Results[K]>> {
    const search = await this.searchAndWait({ ...params, query, type }, options);
    return (search.results?.[type] ?? []) as NonNullable<V1Results[K]>;
  }

  /** News search (`type=news`). */
  searchNews(query: string, params?: VerticalParams, options?: WaitForOptions): Promise<V1News[]> {
    return this.vertical("news", query, params, options);
  }

  /** Video search (`type=videos`). */
  searchVideos(query: string, params?: VerticalParams, options?: WaitForOptions): Promise<V1Video[]> {
    return this.vertical("videos", query, params, options);
  }

  /** Image search (`type=images`). Tip: `{ thumbnails: false }` makes responses much smaller. */
  searchImages(query: string, params?: VerticalParams, options?: WaitForOptions): Promise<V1Image[]> {
    return this.vertical("images", query, params, options);
  }

  /** Product search (`type=shopping`). */
  searchShopping(query: string, params?: VerticalParams, options?: WaitForOptions): Promise<V1Product[]> {
    return this.vertical("shopping", query, params, options);
  }

  /** Local places search (`type=places`). */
  searchPlaces(query: string, params?: VerticalParams, options?: WaitForOptions): Promise<V1Place[]> {
    return this.vertical("places", query, params, options);
  }

  /**
   * Fetches the archived raw HTML via `GET /v1/searches/{id}/html`.
   */
  async html(id: string, options?: RequestOptions): Promise<string> {
    return await this.executeRequest<string>(
      "GET",
      `/v1/searches/${encodeURIComponent(id)}/html`,
      undefined,
      options,
      true,
    );
  }

  /** Returns your plan limits and usage. Does not use credits. */
  async account(options?: RequestOptions): Promise<V1Account> {
    return this.executeRequest<V1Account>("GET", "/v1/account", undefined, options);
  }
}

/**
 * Creates a new QuarryClient.
 */
export function createClient(options?: QuarryClientOptions): QuarryClient {
  return new QuarryClient(options);
}

/** @deprecated Use `QuarryClient`. */
export const GoogleSearchClient = QuarryClient;
/** @deprecated Use `QuarryError`. */
export const GoogleSearchError = QuarryError;
