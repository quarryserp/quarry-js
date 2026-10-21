// Standalone public types for the Quarry v1 API.
// This file has no runtime or build-time dependencies.

import type { GoogleCountry, GoogleLanguage } from "./locales.js";

export type ResolveLinksMode = "organic" | "all" | "none";

export type V1SearchType = "web" | "news" | "videos" | "images" | "shopping" | "places";
export type V1Status = "pending" | "completed" | "failed";

export type V1ErrorCode =
  | "INVALID_PARAMETER"
  | "INVALID_CURSOR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "BLOCKED_BY_CAPTCHA"
  /** 403: valid key, but the endpoint requires an admin key. */
  | "FORBIDDEN"
  /** 429: the monthly quota is used up. */
  | "QUOTA_EXCEEDED"
  /** 429: per-minute request limit exceeded (see the Retry-After header). */
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface V1Error {
  code: V1ErrorCode;
  message: string;
  /** true when the same request may succeed if retried later. */
  retryable: boolean;
}

export interface V1Query {
  text: string;
  type: V1SearchType;
  lang?: string;
  country?: string;
  engine: "google";
  /** URL of the Google results page that was fetched. */
  sourceUrl?: string;
}

export interface V1Sitelink {
  title: string;
  url: string;
  snippet?: string;
}

export interface V1Organic {
  rank: number;
  title: string;
  url: string;
  displayUrl?: string;
  /** Hostname of `url`, e.g. "github.com". */
  domain?: string;
  siteName?: string;
  snippet?: string;
  highlights?: string[];
  /** ISO date (YYYY-MM-DD or datetime) when the date text could be parsed. */
  publishedAt?: string;
  /** Date text as shown by Google, e.g. "Nov 8, 2025" or "3 days ago". */
  publishedText?: string;
  faviconUrl?: string;
  sitelinks?: V1Sitelink[];
}

export interface V1Video {
  rank: number;
  title: string;
  url: string;
  displayUrl?: string;
  source?: string;
  channel?: string;
  publishedAt?: string;
  publishedText?: string;
  snippet?: string;
  duration?: string;
  thumbnailUrl?: string;
}

export interface V1Image {
  rank: number;
  title?: string;
  pageUrl?: string;
  source?: string;
  imageUrl?: string;
  imageUrlFrom?: "google" | "page";
  width?: number;
  height?: number;
  thumbnailUrl?: string;
}

export interface V1Product {
  rank: number;
  title: string;
  url?: string;
  source?: string;
  priceText?: string;
  price?: number;
  oldPriceText?: string;
  oldPrice?: number;
  rating?: number;
  reviews?: number;
  delivery?: string;
  thumbnailUrl?: string;
}

export interface V1AiOverview {
  text: string;
  blocks: { type: "paragraph" | "heading" | "list"; text?: string; items?: string[] }[];
  references?: { title: string; url: string; source?: string }[];
}

export interface V1Place {
  rank: number;
  title: string;
  placeId?: string;
  rating?: number;
  reviews?: number;
  price?: string;
  category?: string;
  address?: string;
  hours?: string;
  phone?: string;
  website?: string;
  mapsUrl?: string;
  thumbnailUrl?: string;
}

export interface V1News {
  rank: number;
  title: string;
  url: string;
  source?: string;
  publishedAt?: string;
  publishedText?: string;
  snippet?: string;
  thumbnailUrl?: string;
}

export interface V1TopStory {
  title: string;
  url: string;
  source?: string;
  publishedText?: string;
  thumbnailUrl?: string;
}

export interface V1KnowledgePanel {
  title: string;
  type?: string;
  description?: string;
  source?: { name: string; url?: string };
  attributes?: { label: string; value: string }[];
  imageUrl?: string;
  relatedEntities?: { name: string; searchUrl: string }[];
  profiles?: { name: string; url: string }[];
  images?: { pageUrl: string; thumbnailUrl?: string }[];
}

export interface V1RelatedQuery {
  query: string;
  /** Relative API path that runs this query, e.g. "/v1/search?cursor=…". */
  searchUrl: string;
}

export interface V1Results {
  organic: V1Organic[];
  questions: string[];
  relatedQueries: V1RelatedQuery[];
  news?: V1News[];
  videos?: V1Video[];
  images?: V1Image[];
  shopping?: V1Product[];
  places?: V1Place[];
  aiOverview?: V1AiOverview;
  topStories?: V1TopStory[];
  knowledgePanel?: V1KnowledgePanel;
}

export interface V1Pagination {
  hasNext: boolean;
  nextCursor?: string;
  prevCursor?: string;
}

export interface V1Meta {
  cached: boolean;
  createdAt: string;
  completedAt?: string;
  /** Total time from request to completion: queueMs + searchMs. */
  durationMs?: number;
  /** Time spent waiting in the queue. */
  queueMs?: number;
  /** Time spent running the search. */
  searchMs?: number;
  /** Per-stage durations in ms (same as the Server-Timing header). */
  timings?: Record<string, number>;
  /** Relative path to the raw HTML, e.g. "/v1/searches/{id}/html". */
  htmlUrl?: string;
  /** E.g. "NO_RESULTS" when the search succeeded but returned nothing. */
  warning?: string;
}

/** Response of GET /v1/search, POST /v1/searches and GET /v1/searches/{id}. */
export interface V1Search {
  id: string;
  status: V1Status;
  query: V1Query;
  /** Present when status is "completed". */
  results?: V1Results;
  pagination?: V1Pagination;
  meta: V1Meta;
  /** Present when status is "pending": relative path to poll. */
  pollUrl?: string;
  retryAfterMs?: number;
  /** Present when status is "failed". */
  error?: V1Error;
}

/** Decoded cursor (base64url JSON). Send it on its own: `?cursor=…`. */
export interface V1Cursor {
  v: 1;
  query: string;
  type: V1SearchType;
  lang?: string;
  country?: string;
  /** Google result offset (`start`). */
  start: number;
  resolveLinks: ResolveLinksMode;
}

// ==================== Client types ====================

/** v1 search parameters. */
export interface SearchParams {
  /** Search text. Required unless `cursor` is set. */
  query?: string;
  /** Result type: "web" (default), "news", "videos", "images", "shopping" or "places". */
  type?: V1SearchType;
  /** Language code (Google `hl`), e.g. "en", "de", "pt-BR". */
  lang?: GoogleLanguage;
  /** Country code (Google `gl`), e.g. "us", "gb", "jp". */
  country?: GoogleCountry;
  /** Pagination cursor; replaces query, type, lang, country and resolveLinks. */
  cursor?: string;
  /** "sync" (default) waits for the result; "async" returns immediately. */
  mode?: "sync" | "async";
  /** Serve repeated searches from cache (default: true). */
  cache?: boolean;
  /** Which Google redirect links to resolve: "organic" (default), "all" or "none". */
  resolveLinks?: ResolveLinksMode;
  /** false strips thumbnails, favicons and panel images (large data URIs) from the response. */
  thumbnails?: boolean;
  /** "page" fills missing image URLs with the source page's og:image (type=images). Default "none". */
  imageFallback?: "none" | "page";
}

/** Parameters for the result-type helpers (`searchNews`, `searchVideos`, ...); the helper sets `query` and `type`. */
export type VerticalParams = Omit<SearchParams, "query" | "type" | "cursor">;

/** Retry settings for retryable errors. */
export interface RetryOptions {
  /** Maximum number of retries for retryable errors (default: 0). */
  attempts?: number;
  /** Initial backoff before a retry, in ms (default: 500). */
  backoffMs?: number;
}

/** QuarryClient constructor options. */
export interface QuarryClientOptions {
  /** API base URL (default: "https://api.quarryserp.com"). */
  baseUrl?: string;
  /** Your API key, sent as a Bearer token. */
  apiKey?: string;
  /** Custom fetch implementation (default: the global fetch). */
  fetch?: typeof fetch;
  /** Default timeout per HTTP request in ms (default: 120000 = 2 minutes). */
  timeoutMs?: number;
  /** Optional User-Agent header. */
  userAgent?: string;
  /** Default retry settings for retryable errors. */
  retry?: RetryOptions;
}

/** Per-call request options. */
export interface RequestOptions {
  /** AbortSignal to cancel the request. */
  signal?: AbortSignal;
  /** Request timeout in ms (overrides the client default). */
  timeoutMs?: number;
  /** Retry settings for this request. */
  retry?: RetryOptions;
}

/** Options for waitFor. */
export interface WaitForOptions extends RequestOptions {
  /** Total polling timeout in ms. */
  timeoutMs?: number;
}

/** Options for paginate. */
export interface PaginateOptions extends RequestOptions {
  /** Maximum number of pages the iterator yields. */
  maxPages?: number;
}

/** Error code: a server V1ErrorCode, or "NETWORK_ERROR" for connection failures and timeouts. */
export type ClientErrorCode = V1ErrorCode | "NETWORK_ERROR";

/** Account plan and usage for the current UTC month. */
export interface V1Account {
  keyId: string;
  name: string;
  admin: boolean;
  plan: { monthlyQuota: number | null; ratePerMinute: number | null };
  usage: { month: string; used: number; remaining: number | null };
}

/** @deprecated Use `QuarryClientOptions`. */
export type GoogleSearchClientOptions = QuarryClientOptions;
