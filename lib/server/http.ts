import { z } from "zod";
import { ApiError, MAX_BODY_BYTES } from "./domain.ts";
import type {
  Action,
  DeliveryQuery,
  ReplayBatchRequest,
} from "../contracts.ts";

const object = z.record(z.unknown());
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const cycle = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialize") }).strict(),
  z
    .object({
      type: z.literal("send"),
      endpointId: identifier,
      eventType: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
      payload: object.optional(),
      idempotencyKey: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z.object({ type: z.literal("demo") }).strict(),
  z
    .object({
      type: z.literal("set-receiver"),
      endpointId: identifier,
      mode: z.enum(["healthy", "flaky", "failing", "timeout"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("replay"),
      eventId: identifier,
      expectedCycle: cycle.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("start-recovery-demo"),
      previousEventId: identifier.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("repair-recovery-demo"),
      eventId: identifier,
      expectedCycle: cycle,
    })
    .strict(),
  z
    .object({
      type: z.literal("replay-recovery-demo"),
      eventId: identifier,
      expectedCycle: cycle,
    })
    .strict(),
  z.object({ type: z.literal("pause"), paused: z.boolean() }).strict(),
  z.object({ type: z.literal("pump") }).strict(),
]);

const replayBatchSchema = z
  .object({
    items: z
      .array(z.object({ eventId: identifier, expectedCycle: cycle }).strict())
      .min(1)
      .max(20)
      .refine(
        (items) =>
          new Set(items.map((item) => item.eventId)).size === items.length,
      ),
  })
  .strict();

const positiveInteger = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(max));
const deliveryQuerySchema = z
  .object({
    page: positiveInteger(500).default("1"),
    pageSize: positiveInteger(50).default("20"),
    search: z.string().trim().max(100).default(""),
    status: z
      .enum(["all", "pending", "retrying", "delivered", "dead"])
      .default("all"),
    endpointId: z.union([z.literal("all"), identifier]).default("all"),
  })
  .strict();

export function parseDeliveryQuery(request: Request): DeliveryQuery {
  const params = new URL(request.url).searchParams;
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key))
      throw new ApiError(400, "Duplicate query parameters are not allowed.");
    Object.defineProperty(values, key, { value, enumerable: true });
  }
  const parsed = deliveryQuerySchema.safeParse(values);
  if (!parsed.success)
    throw new ApiError(
      400,
      "Invalid delivery filters. Check the page, page size, search, status and endpoint.",
    );
  return parsed.data;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  let sameOrigin = false;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin || "");
    // Next.js may normalize its internal request URL to localhost. The actual
    // incoming Host remains the browser's destination; forwarded hosts are ignored.
    const destination = new URL(
      `${requestUrl.protocol}//${request.headers.get("host") || requestUrl.host}`,
    );
    sameOrigin =
      (requestUrl.protocol === "https:" || requestUrl.protocol === "http:") &&
      origin === originUrl.origin &&
      originUrl.protocol === requestUrl.protocol &&
      originUrl.host === destination.host &&
      !destination.username &&
      !destination.password &&
      destination.pathname === "/" &&
      !destination.search &&
      !destination.hash;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || site === "cross-site")
    throw new ApiError(403, "A same-origin request is required.");
}

export async function readBody(request: Request): Promise<string> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new ApiError(415, "Use application/json.");
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES)
    throw new ApiError(413, "Request body is too large.");
  if (!request.body) throw new ApiError(400, "A JSON body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large.");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid request encoding.");
  } finally {
    reader.releaseLock();
  }
  return body;
}

/** Bound traversal before canonical serialization to avoid recursive stack exhaustion. */
export function assertJsonComplexity(value: unknown): void {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > 2000 || current.depth > 24)
      throw new ApiError(400, "JSON is too deeply nested or complex.");
    if (typeof current.value === "object" && current.value !== null) {
      for (const child of Object.values(current.value))
        stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export async function parseAction(request: Request): Promise<Action> {
  const body = await readBody(request);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError(400, "Invalid JSON.");
  }
  assertJsonComplexity(value);
  const parsed = actionSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "Invalid action. Check the event type, endpoint, payload and fields.",
    );
  return parsed.data as Action;
}

export async function parseReplayBatch(
  request: Request,
): Promise<ReplayBatchRequest> {
  const body = await readBody(request);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError(400, "Invalid JSON.");
  }
  assertJsonComplexity(value);
  const parsed = replayBatchSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "Select 1–20 unique events with their current replay cycles.",
    );
  return parsed.data;
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function route(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError)
      return json({ error: error.message }, error.status);
    console.error(
      "RelayForge request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return json(
      {
        error:
          "The service could not complete this request. Try again shortly.",
      },
      500,
    );
  }
}
