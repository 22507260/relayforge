import { database } from "../../../../lib/server/database";
import { ApiError } from "../../../../lib/server/domain";
import {
  enqueueProducerEvent,
  ProducerRateLimitError,
  readIntegrationJson,
} from "../../../../lib/server/integrations";
import { json, route } from "../../../../lib/server/http";

/** Producer authentication is independent of browser cookies and never falls back to a session. */
export async function POST(request: Request): Promise<Response> {
  let retryAfter: number | null = null;
  const response = await route(async () => {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer (rf_live_[A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) throw new ApiError(401, "A Bearer producer key is required.");
    try {
      const result = await enqueueProducerEvent(
        database(),
        match[1],
        request.headers.get("idempotency-key") ?? "",
        await readIntegrationJson(request),
      );
      return json(result, 202);
    } catch (error) {
      if (error instanceof ProducerRateLimitError)
        retryAfter = error.retryAfter;
      throw error;
    }
  });
  if (retryAfter !== null)
    response.headers.set("retry-after", String(retryAfter));
  return response;
}
