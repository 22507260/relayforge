import assert from "node:assert/strict";
import { test } from "node:test";
import {
  api,
  isSessionError,
  parseRetryAfter,
  RequestError,
} from "../lib/client-api.ts";

const requestId = "89e60b18-ef16-42c7-bf17-0f76577196c9";
const now = Date.parse("Tue, 13 Oct 2026 12:00:00 GMT");

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("Retry-After uses bounded numeric seconds and rejects malformed or excessive timers", () => {
  assert.equal(parseRetryAfter("600", null, now), now + 600_000);
  assert.equal(parseRetryAfter("0", null, now), now);
  assert.equal(parseRetryAfter("86400", null, now), now + 86_400_000);
  for (const value of [
    null,
    "",
    "-1",
    "1.5",
    "1e3",
    "Infinity",
    "86401",
    "9".repeat(101),
    "tomorrow",
  ])
    assert.equal(parseRetryAfter(value, null, now), null, String(value));
  assert.equal(parseRetryAfter("10", null, Infinity), null);
});

test("Retry-After dates use server clock offset and past deadlines do not block retries", () => {
  assert.equal(
    parseRetryAfter(
      "Tue, 13 Oct 2026 14:10:00 GMT",
      "Tue, 13 Oct 2026 14:00:00 GMT",
      now,
    ),
    now + 600_000,
  );
  assert.equal(
    parseRetryAfter("Tue, 13 Oct 2026 12:10:00 GMT", "invalid", now),
    now + 600_000,
  );
  assert.equal(
    parseRetryAfter("Tue, 13 Oct 2026 11:00:00 GMT", null, now),
    now,
  );
  assert.equal(
    parseRetryAfter("Thu, 15 Oct 2026 12:00:00 GMT", null, now),
    null,
  );
  assert.equal(
    parseRetryAfter("Tue, 32 Oct 2026 12:00:00 GMT", null, now),
    null,
  );
  assert.equal(
    parseRetryAfter(
      "Tue, 30 Feb 2027 12:00:00 GMT",
      null,
      Date.parse("Mon, 01 Mar 2027 12:00:00 GMT"),
    ),
    null,
  );
});

test("shared API preserves authenticated GET and JSON mutation request contracts", async () => {
  const calls: { url: unknown; options?: RequestInit }[] = [];
  const controller = new AbortController();
  await withFetch(
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    },
    async () => {
      assert.deepEqual(
        await api("/api/snapshot", undefined, controller.signal),
        { ok: true },
      );
      await api("/api/action", { type: "pump" });
      assert.equal(calls[0].options?.credentials, "same-origin");
      assert.equal(calls[0].options?.cache, "no-store");
      assert.equal(calls[0].options?.signal, controller.signal);
      assert.equal(calls[1].options?.method, "POST");
      assert.equal(calls[1].options?.body, '{"type":"pump"}');
    },
  );
});

test("current-password and invalid-credential errors remain inline without ending a live session", async () => {
  await withFetch(
    async (url) =>
      Response.json(
        {
          error:
            url === "/api/security"
              ? "Current password is incorrect."
              : "Email or password is incorrect.",
          code:
            url === "/api/security"
              ? "current_password_incorrect"
              : "invalid_credentials",
          requestId,
        },
        { status: 401 },
      ),
    async () => {
      for (const url of ["/api/security", "/api/auth/login"]) {
        await assert.rejects(api(url, {}), (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(isSessionError(error), false);
          assert.equal(error.requestId, requestId);
          assert.ok(!error.message.includes("session has ended"));
          return true;
        });
      }
    },
  );
});

test("auth-required and concurrent-session-change codes identify ended sessions", async () => {
  for (const code of ["auth_required", "session_changed"]) {
    await withFetch(
      async () =>
        Response.json(
          { error: "Internal detail", code, requestId },
          { status: 401 },
        ),
      async () => {
        await assert.rejects(api("/api/snapshot"), (error: unknown) => {
          assert.ok(isSessionError(error));
          assert.equal(
            error.message,
            "Your session has ended. Sign in to continue.",
          );
          return true;
        });
      },
    );
  }
});

test("a password code cannot suppress authentication handling on unrelated endpoints", async () => {
  await withFetch(
    async () =>
      Response.json(
        { error: "Incorrect", code: "current_password_incorrect", requestId },
        { status: 401 },
      ),
    async () => {
      await assert.rejects(api("/api/snapshot"), (error: unknown) => {
        assert.ok(isSessionError(error));
        assert.equal(error.code, "request_failed");
        return true;
      });
    },
  );
});

test("legacy JSON errors still show safe messages while unknown codes and sensitive metadata are discarded", async () => {
  await withFetch(
    async () =>
      Response.json(
        {
          error: "Please try a different value.",
          code: "session-cookie-secret",
          requestId: "password-secret",
          password: "private-password",
          payload: { secret: "private-payload" },
          token: "private-token",
        },
        { status: 400, headers: { "X-Request-ID": requestId } },
      ),
    async () => {
      await assert.rejects(
        api("/api/action", { password: "private-input" }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, "request_failed");
          assert.equal(error.requestId, requestId);
          assert.equal(error.message, "Please try a different value.");
          const serialized = JSON.stringify(error);
          for (const secret of [
            "private-password",
            "private-payload",
            "private-token",
            "private-input",
            "password-secret",
            "session-cookie-secret",
          ])
            assert.ok(!serialized.includes(secret));
          return true;
        },
      );
    },
  );
});

test("error messages are bounded and invalid request IDs are omitted", async () => {
  await withFetch(
    async () =>
      Response.json(
        {
          error: "x".repeat(1000),
          code: "invalid_request",
          requestId: "not-a-request-id",
        },
        { status: 400, headers: { "X-Request-ID": "still-invalid" } },
      ),
    async () => {
      await assert.rejects(api("/api/action", {}), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.message.length, 500);
        assert.equal(error.requestId, null);
        return true;
      });
    },
  );
});

test("429 errors expose an explicit retry deadline and an independently validated request ID", async () => {
  const before = Date.now();
  await withFetch(
    async () =>
      Response.json(
        {
          error: "Wait before signing in again.",
          code: "rate_limited",
          requestId,
        },
        {
          status: 429,
          headers: { "Retry-After": "600" },
        },
      ),
    async () => {
      await assert.rejects(api("/api/auth/login", {}), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.status, 429);
        assert.equal(error.code, "rate_limited");
        assert.ok(
          error.retryAt !== null &&
            error.retryAt >= before + 600_000 &&
            error.retryAt <= Date.now() + 600_000,
        );
        return true;
      });
    },
  );
});

test("network failures use a friendly message without exposing transport internals", async () => {
  await withFetch(
    async () => {
      throw new TypeError("private network detail");
    },
    async () => {
      await assert.rejects(api("/api/snapshot"), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.status, 0);
        assert.ok(error.message.includes("Check your connection"));
        assert.ok(!error.message.includes("private network detail"));
        return true;
      });
    },
  );
});

test("aborted fetches and aborted response parsing retain AbortError identity", async () => {
  const aborted = new DOMException("Aborted", "AbortError");
  await withFetch(
    async () => {
      throw aborted;
    },
    async () => {
      await assert.rejects(
        api("/api/snapshot"),
        (error: unknown) => error === aborted,
      );
    },
  );
  await withFetch(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw aborted;
        },
      }) as unknown as Response,
    async () => {
      await assert.rejects(
        api("/api/snapshot"),
        (error: unknown) => error === aborted,
      );
    },
  );
});

test("malformed JSON never drops a 401 status and successful primitive responses are rejected", async () => {
  await withFetch(
    async () =>
      new Response("<html>Private gateway detail</html>", {
        status: 401,
        headers: { "X-Request-ID": requestId },
      }),
    async () => {
      await assert.rejects(api("/api/security"), (error: unknown) => {
        assert.ok(isSessionError(error));
        assert.equal(error.requestId, requestId);
        assert.ok(!error.message.includes("Private gateway detail"));
        return true;
      });
    },
  );
  for (const body of ["invalid JSON", "null", '"secret string"', "42", "[]"]) {
    await withFetch(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "X-Request-ID": requestId },
        }),
      async () => {
        await assert.rejects(api("/api/snapshot"), (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.status, 200);
          assert.equal(error.requestId, requestId);
          assert.ok(error.message.includes("unexpected response"));
          return true;
        });
      },
    );
  }
});
