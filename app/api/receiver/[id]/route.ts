import { database } from "../../../../lib/server/context";
import { ApiError } from "../../../../lib/server/domain";
import { assertJsonComplexity, json, readBody, route } from "../../../../lib/server/http";
import { RelayService } from "../../../../lib/server/service";

/** Public receiver authentication is HMAC, rather than a browser session. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const signature = request.headers.get("x-relay-signature") ?? "";
    const timestamp = Number(request.headers.get("x-relay-timestamp"));
    if (!/^[a-f0-9]{64}$/.test(signature) || !Number.isSafeInteger(timestamp)) throw new ApiError(401, "A valid receiver signature is required.");
    const { id } = await context.params;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ApiError(400, "Invalid receiver identifier.");
    const body = await readBody(request);
    try { assertJsonComplexity(JSON.parse(body)); } catch { throw new ApiError(400, "Invalid receiver JSON."); }
    const db = database();
    const endpoint = await db.prepare("SELECT owner FROM endpoints WHERE id = ?").bind(id).first<{ owner: string }>();
    if (!endpoint) throw new ApiError(404, "Receiver not found.");
    const result = await new RelayService(db, endpoint.owner).receive(id, body, timestamp, signature);
    return json({ acknowledged: result.status === 200, duplicate: result.duplicate ?? false, error: result.error }, result.status);
  });
}
