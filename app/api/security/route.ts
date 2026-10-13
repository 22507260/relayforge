import { cookies } from "next/headers";
import {
  AuthService,
  SESSION_COOKIE,
  sessionCookie,
} from "../../../lib/server/auth";
import { database } from "../../../lib/server/database";
import {
  assertSameOrigin,
  json,
  parseSecurityAction,
  route,
} from "../../../lib/server/http";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return route(async () => {
    const cookieStore = await cookies();
    return json(
      await new AuthService(database()).getSecurity(
        cookieStore.get(SESSION_COOKIE)?.value,
      ),
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  const response = await route(async () => {
    assertSameOrigin(request);
    const cookieStore = await cookies();
    const result = await new AuthService(database()).mutateSecurity(
      cookieStore.get(SESSION_COOKIE)?.value,
      await parseSecurityAction(request),
    );
    // Raw tokens are sent only through the HttpOnly session cookie.
    const response = json({
      security: result.security,
      revokedSessions: result.revokedSessions,
    });
    if (result.newSession)
      response.headers.set(
        "set-cookie",
        sessionCookie(result.newSession.token),
      );
    return response;
  });
  if (response.status === 429) response.headers.set("retry-after", "600");
  return response;
}
