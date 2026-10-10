import { cookies } from "next/headers";
import { AuthService, SESSION_COOKIE } from "./auth.ts";
import { database } from "./database.ts";
import { ApiError } from "./domain.ts";
import { RelayService } from "./service.ts";
export { database } from "./database.ts";
export async function authenticatedService(): Promise<RelayService> {
  const cookieStore = await cookies();
  const user = await new AuthService(database()).userForSession(
    cookieStore.get(SESSION_COOKIE)?.value,
  );
  if (!user)
    throw new ApiError(401, "Sign in to open your RelayForge workspace.");
  return new RelayService(database(), user.id, Date.now, Math.random, user);
}
