import { Effect, Layer, Option } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpMethod from "effect/unstable/http/HttpMethod";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { NodeHttpServer } from "@effect/platform-node";
import { createServer } from "node:http";
import type { ListenOptions } from "node:net";

import { defaultConfig } from "./config.js";

export interface DciProxyOptions {
  readonly prefix?: string;
  readonly target?: string;
  readonly corsOrigin?: string;
}

export interface DciProxyServerOptions extends DciProxyOptions {
  readonly port?: number;
  readonly hostname?: string;
}

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return defaultConfig.baseUrl;
  }
  return trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
};

const normalizePrefix = (value: string) => {
  if (!value || value === "/") {
    return "/";
  }
  let prefix = value.trim();
  if (!prefix.startsWith("/")) {
    prefix = `/${prefix}`;
  }
  if (prefix.length > 1 && prefix.endsWith("/")) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
};

const sanitizeHeaders = (headers: Headers.Headers, upstream: URL, prefix: string) => {
  let next = Headers.remove(headers, "host");
  next = Headers.remove(next, "content-length");
  next = Headers.set(next, "host", upstream.host);
  next = Headers.set(next, "x-forwarded-host", upstream.host);
  next = Headers.set(next, "x-forwarded-proto", upstream.protocol.replace(/:$/, ""));
  next = Headers.set(next, "x-forwarded-prefix", prefix);
  return next;
};

const stripPrefix = (pathname: string, prefix: string) => {
  if (prefix === "/" || prefix === "") {
    return pathname || "/";
  }
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const stripped = pathname.slice(prefix.length) || "/";
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
};

const isBodylessMethod = (method: string) => {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
};

const toNumber = (value?: string) => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const proxyRequest = (
  options: Required<DciProxyOptions>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* (HttpServerRequest.HttpServerRequest);
    const incomingUrl = new URL(request.url, "http://proxy.local");
    const relativePath = stripPrefix(incomingUrl.pathname, options.prefix);
    if (!relativePath) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const upstreamUrl = new URL(`${relativePath}${incomingUrl.search}`, options.target);
    const headers = sanitizeHeaders(request.headers, upstreamUrl, options.prefix);
    const hasBody = !isBodylessMethod(request.method);
    const contentType = Option.getOrUndefined(Headers.get(request.headers, "content-type"));
    const contentLength = toNumber(Option.getOrUndefined(Headers.get(request.headers, "content-length")));

    const builder = HttpClientRequest.make(request.method as HttpMethod.HttpMethod);
    const upstreamRequest = hasBody
      ? builder(upstreamUrl, {
          headers,
          body: HttpBody.stream(request.stream, contentType, contentLength)
        })
      : builder(upstreamUrl, { headers });

    const client = yield* (HttpClient.HttpClient);
    const upstreamResponse = yield* (client.execute(upstreamRequest));
    const shouldReadBody =
      request.method.toUpperCase() !== "HEAD" && ![204, 205, 304].includes(upstreamResponse.status);

    const responseBody = shouldReadBody ? yield* (upstreamResponse.arrayBuffer) : undefined;

    let response =
      responseBody !== undefined
        ? HttpServerResponse.uint8Array(new Uint8Array(responseBody), {
            status: upstreamResponse.status,
            headers: upstreamResponse.headers
          })
        : HttpServerResponse.empty({
            status: upstreamResponse.status,
            headers: upstreamResponse.headers
          });

    if (options.corsOrigin) {
      response = HttpServerResponse.setHeader("Access-Control-Allow-Origin", options.corsOrigin)(response);
      response = HttpServerResponse.setHeader("Vary", "Origin")(response);
    }

    return response;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.text(`Proxy error: ${error instanceof Error ? error.message : String(error)}`, {
          status: 502
        })
      )
    )
  );

// A catch-all proxy: every request is handled by the same response effect, so
// v4's `HttpServer.serve(effect)` (no router) is the natural fit. The handler
// itself does prefix matching and returns 404 for non-matching paths.
export const makeDciProxyHandler = (options?: DciProxyOptions) => {
  const resolvedOptions: Required<DciProxyOptions> = {
    prefix: normalizePrefix(options?.prefix ?? "/"),
    target: normalizeBaseUrl(options?.target ?? defaultConfig.baseUrl),
    corsOrigin: options?.corsOrigin ?? ""
  };
  return proxyRequest(resolvedOptions);
};

export const makeDciProxyServerLayer = (options?: DciProxyServerOptions) => {
  const listen: ListenOptions = {
    port: options?.port ?? 8787,
    host: options?.hostname ?? "0.0.0.0"
  };
  return makeDciProxyHandler(options).pipe(
    HttpServer.serve(),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeHttpServer.layer(() => createServer(), listen))
  );
};

// v4's Config is Schema-based; for a handful of optional env vars a direct read
// is simpler and keeps this layer factory synchronous.
const envString = (key: string) => {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
};

export const makeDciProxyServerLayerFromConfig = () =>
  makeDciProxyServerLayer({
    prefix: envString("DCI_API_PROXY_PREFIX"),
    target: envString("DCI_API_PROXY_TARGET"),
    corsOrigin: envString("DCI_API_PROXY_CORS_ORIGIN"),
    port: toNumber(envString("DCI_API_PROXY_PORT")),
    hostname: envString("DCI_API_PROXY_HOST")
  });
