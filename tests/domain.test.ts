import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  canonicalJson,
  hashPayload,
  MAX_ATTEMPTS,
  nextStatus,
  retryDelayMs,
  signPayload,
  verifySignature,
} from "../lib/server/domain.ts";
import {
  assertSameOrigin,
  parseAction,
  parseDeliveryQuery,
} from "../lib/server/http.ts";

test("delivery query boundary accepts bounded filters and rejects ambiguous or unbounded requests", () => {
  const parse = (query: string) =>
    parseDeliveryQuery(
      new Request(`https://relay.example/api/deliveries${query}`),
    );
  assert.deepEqual(parse(""), {
    page: 1,
    pageSize: 20,
    search: "",
    status: "all",
    endpointId: "all",
  });
  assert.deepEqual(
    parse(
      "?page=2&pageSize=50&search=%20Billing%20&status=dead&endpointId=billing_123",
    ),
    {
      page: 2,
      pageSize: 50,
      search: "Billing",
      status: "dead",
      endpointId: "billing_123",
    },
  );
  for (const query of [
    "?page=0",
    "?page=-1",
    "?page=1.5",
    "?page=501",
    "?pageSize=0",
    "?pageSize=51",
    "?status=failed",
    "?endpointId=x%27",
    "?page=1&page=2",
    "?owner=bob",
    "?__proto__=x",
    `?search=${"x".repeat(101)}`,
  ]) {
    assert.throws(
      () => parse(query),
      (error: unknown) => error instanceof ApiError && error.status === 400,
      query,
    );
  }
});

test("HMAC binds timestamp and exact raw bytes, and expires captured signatures", async () => {
  const now = 1_800_000_000_000;
  const body = '{"event":"invoice.paid"}';
  const signature = await signPayload("server-only-secret", now, body);
  assert.equal(
    await verifySignature("server-only-secret", now, body, signature, now),
    true,
  );
  assert.equal(
    await verifySignature("different-secret", now, body, signature, now),
    false,
  );
  assert.equal(
    await verifySignature(
      "server-only-secret",
      now,
      body + " ",
      signature,
      now,
    ),
    false,
  );
  assert.equal(
    await verifySignature("server-only-secret", now + 1, body, signature, now),
    false,
  );
  assert.equal(
    await verifySignature(
      "server-only-secret",
      now,
      body,
      signature,
      now + 300_001,
    ),
    false,
  );
  assert.equal(
    await verifySignature("server-only-secret", now, body, "not hex", now),
    false,
  );
});

test("canonical payload identity ignores key order and preserves actual values", async () => {
  assert.equal(
    await hashPayload(canonicalJson({ a: 1, b: { y: 2, x: 3 } })),
    await hashPayload(canonicalJson({ b: { x: 3, y: 2 }, a: 1 })),
  );
  assert.notEqual(canonicalJson({ amount: 1 }), canonicalJson({ amount: "1" }));
  assert.throws(() => canonicalJson({ undefined }), ApiError);
});

test("retry budget terminates and jitter stays within bounded exponential delays", () => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const base = 1000 * 2 ** (attempt - 1);
    assert.equal(retryDelayMs(attempt, 0), base * 0.8);
    assert.equal(retryDelayMs(attempt, 1), base * 1.2);
    assert.equal(
      nextStatus(false, attempt),
      attempt === MAX_ATTEMPTS ? "dead" : "retrying",
    );
    assert.equal(nextStatus(true, attempt), "delivered");
  }
  assert.throws(() => retryDelayMs(0));
});

test("same-origin checks use the incoming host and reject forged forwarded hosts", () => {
  const request = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/action", { headers });
  assertSameOrigin(
    request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }),
  );
  assertSameOrigin(
    request({ host: "relay.example", origin: "http://relay.example" }),
  );
  const rejectedHeaders: Record<string, string>[] = [
    { host: "127.0.0.1:3000", origin: "http://localhost:3000" },
    { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
    {
      host: "relay.example",
      origin: "http://evil.example",
      "x-forwarded-host": "evil.example",
    },
    {
      host: "relay.example",
      origin: "http://relay.example",
      "sec-fetch-site": "cross-site",
    },
    { host: "user@relay.example", origin: "http://relay.example" },
    { host: "relay.example/unexpected", origin: "http://relay.example" },
    { host: "relay.example", origin: "null" },
    { host: "relay.example", origin: "http://relay.example/" },
    { host: "relay.example" },
  ];
  for (const headers of rejectedHeaders)
    assert.throws(
      () => assertSameOrigin(request(headers)),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
});

test("action boundary rejects cross-origin writes, oversized JSON and excessive nesting", async () => {
  assert.throws(
    () =>
      assertSameOrigin(
        new Request("https://relay.example/api/action", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  assertSameOrigin(
    new Request("https://relay.example/api/action", {
      headers: { origin: "https://relay.example" },
    }),
  );
  const request = (body: string) =>
    new Request("https://relay.example/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  await assert.rejects(
    parseAction(
      request(
        JSON.stringify({
          type: "send",
          endpointId: "test",
          eventType: "invoice.paid",
          payload: { message: "x".repeat(20_000) },
        }),
      ),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  let value: unknown = 1;
  for (let depth = 0; depth < 30; depth++) value = { nested: value };
  await assert.rejects(
    parseAction(
      request(
        JSON.stringify({
          type: "send",
          endpointId: "test",
          eventType: "invoice.paid",
          payload: value,
        }),
      ),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await assert.rejects(
    parseAction(request('{"type":"pump","owner":"someone-else"}')),
    ApiError,
  );
});
