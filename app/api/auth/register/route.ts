import {
  AuthService,
  parseCredentials,
  sessionCookie,
} from "../../../../lib/server/auth";
import { database } from "../../../../lib/server/database";
import { assertSameOrigin, json, route } from "../../../../lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const response = await route(async () => {
    assertSameOrigin(request);
    const session = await new AuthService(database()).register(
      await parseCredentials(request),
    );
    const response = json({ ok: true }, 201);
    response.headers.set("set-cookie", sessionCookie(session.token));
    return response;
  });
  if (response.status === 429) response.headers.set("retry-after", "600");
  return response;
}
