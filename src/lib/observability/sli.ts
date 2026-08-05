import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

type RouteMetric = {
  route: string;
  total: number;
  success: number;
  clientError: number;
  serverError: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastStatus: number;
  lastSeenAt: string;
};

type SliStore = {
  startedAt: string;
  routes: Record<string, RouteMetric>;
};

declare global {
  var __cr8orSliStore: SliStore | undefined;
}

function getStore(): SliStore {
  if (!globalThis.__cr8orSliStore) {
    globalThis.__cr8orSliStore = {
      startedAt: new Date().toISOString(),
      routes: {},
    };
  }
  return globalThis.__cr8orSliStore;
}

function ensureMetric(route: string): RouteMetric {
  const store = getStore();
  const existing = store.routes[route];
  if (existing) {
    return existing;
  }

  const created: RouteMetric = {
    route,
    total: 0,
    success: 0,
    clientError: 0,
    serverError: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastStatus: 0,
    lastSeenAt: "",
  };
  store.routes[route] = created;
  return created;
}

function observe(route: string, status: number, durationMs: number) {
  const metric = ensureMetric(route);
  metric.total += 1;
  metric.totalDurationMs += durationMs;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
  metric.lastStatus = status;
  metric.lastSeenAt = new Date().toISOString();

  if (status >= 500) {
    metric.serverError += 1;
  } else if (status >= 400) {
    metric.clientError += 1;
  } else {
    metric.success += 1;
  }
}

function withTelemetryHeaders(response: Response, requestId: string, durationMs: number): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.append("server-timing", `total;dur=${durationMs.toFixed(1)}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function withRouteMetrics(
  route: string,
  handler: (request: NextRequest, context: { requestId: string }) => Promise<Response>,
) {
  return async function routeHandler(request: NextRequest): Promise<Response> {
    const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
    const startMs = Date.now();

    try {
      const response = await handler(request, { requestId });
      const durationMs = Date.now() - startMs;
      observe(route, response.status, durationMs);
      return withTelemetryHeaders(response, requestId, durationMs);
    } catch (error) {
      const durationMs = Date.now() - startMs;
      observe(route, 500, durationMs);
      throw error;
    }
  };
}

export function getSliSnapshot() {
  const store = getStore();
  const routes = Object.values(store.routes)
    .sort((a, b) => a.route.localeCompare(b.route))
    .map((metric) => ({
      route: metric.route,
      total: metric.total,
      success: metric.success,
      clientError: metric.clientError,
      serverError: metric.serverError,
      successRate: metric.total > 0 ? Number((metric.success / metric.total).toFixed(4)) : 0,
      avgDurationMs: metric.total > 0 ? Number((metric.totalDurationMs / metric.total).toFixed(2)) : 0,
      maxDurationMs: Number(metric.maxDurationMs.toFixed(2)),
      lastStatus: metric.lastStatus,
      lastSeenAt: metric.lastSeenAt,
    }));

  return {
    startedAt: store.startedAt,
    generatedAt: new Date().toISOString(),
    routes,
  };
}
