import { API_ERROR_CODES, type ApiErrorCode } from "./contracts.ts";

const maximumRetryDelay = 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const httpDate =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const parseHttpDate = (value: string | null) => {
  if (!value || !httpDate.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value
    ? parsed
    : NaN;
};

export class RequestError extends Error {
  readonly name = "RequestError";
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string | null;
  readonly retryAt: number | null;

  constructor(
    message: string,
    status: number,
    code: ApiErrorCode = "request_failed",
    requestId: string | null = null,
    retryAt: number | null = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAt = retryAt;
  }
}

/** Use server time for an HTTP-date deadline, without trusting unlimited delays. */
export function parseRetryAfter(
  value: string | null,
  serverDate: string | null = null,
  now = Date.now(),
): number | null {
  if (value === null || value.length > 100 || !Number.isFinite(now))
    return null;
  const trimmed = value.trim();
  let delay: number;
  if (/^\d+$/.test(trimmed)) delay = Number(trimmed) * 1000;
  else {
    if (!httpDate.test(trimmed)) return null;
    const deadline = parseHttpDate(trimmed);
    const serverNow = parseHttpDate(serverDate);
    delay = deadline - (Number.isFinite(serverNow) ? serverNow : now);
  }
  if (!Number.isFinite(delay) || delay > maximumRetryDelay) return null;
  return now + Math.max(0, delay);
}

export function isSessionError(error: unknown): error is RequestError {
  return (
    error instanceof RequestError &&
    error.status === 401 &&
    error.code !== "current_password_incorrect" &&
    error.code !== "invalid_credentials"
  );
}

function isAbort(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function fallbackMessage(status: number) {
  if (status === 401) return "Your session has ended. Sign in to continue.";
  if (status === 429)
    return "Too many requests. Please wait before trying again.";
  if (status >= 500)
    return "RelayForge could not complete this request. Please try again.";
  return "The request could not be completed. Please try again.";
}

function metadata(body: unknown, response: Response, url: string) {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  let code: ApiErrorCode =
    typeof record?.code === "string" &&
    (API_ERROR_CODES as readonly string[]).includes(record.code)
      ? (record.code as ApiErrorCode)
      : "request_failed";
  // A password verification failure is only meaningful for this protected action.
  if (
    code === "current_password_incorrect" &&
    (response.status !== 401 || url.split("?")[0] !== "/api/security")
  )
    code = "request_failed";
  const bodyId =
    typeof record?.requestId === "string" && uuid.test(record.requestId)
      ? record.requestId
      : null;
  const headerId = response.headers.get("X-Request-ID");
  const requestId =
    bodyId ?? (headerId && uuid.test(headerId) ? headerId : null);
  const suppliedMessage =
    typeof record?.error === "string"
      ? record.error
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, 500)
      : "";
  const message =
    code === "auth_required" || code === "session_changed"
      ? "Your session has ended. Sign in to continue."
      : suppliedMessage || fallbackMessage(response.status);
  return {
    code,
    requestId,
    message,
    retryAt:
      response.status === 429
        ? parseRetryAfter(
            response.headers.get("Retry-After"),
            response.headers.get("Date"),
          )
        : null,
  };
}

/** Account APIs return JSON. Sensitive request/response bodies never become error metadata. */
export async function api<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      url,
      body === undefined
        ? { cache: "no-store", credentials: "same-origin", signal }
        : {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          },
    );
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new RequestError(
      "Unable to reach RelayForge. Check your connection and try again.",
      0,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    if (isAbort(error)) throw error;
    const info = metadata(null, response, url);
    throw new RequestError(
      response.ok
        ? "RelayForge returned an unexpected response. Please try again."
        : info.message,
      response.status,
      info.code,
      info.requestId,
      info.retryAt,
    );
  }
  if (!response.ok) {
    const info = metadata(result, response, url);
    throw new RequestError(
      info.message,
      response.status,
      info.code,
      info.requestId,
      info.retryAt,
    );
  }
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new RequestError(
      "RelayForge returned an unexpected response. Please try again.",
      response.status,
      "request_failed",
      metadata(null, response, url).requestId,
    );
  return result as T;
}
