import { cookies } from "next/headers";
import {
  AuthService,
  SESSION_COOKIE,
  sessionCookie,
} from "../../../../lib/server/auth";
import { database } from "../../../../lib/server/database";
import { assertSameOrigin, json, route } from "../../../../lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const cookieStore = await cookies();
    await new AuthService(database()).logout(
      cookieStore.get(SESSION_COOKIE)?.value,
    );
    const response = json({ ok: true });
    response.headers.set("set-cookie", sessionCookie(""));
    return response;
  });
}
