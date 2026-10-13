import { cookies } from "next/headers";
import { AuthService, SESSION_COOKIE, type AuthUser } from "./auth.ts";
import { database } from "./database.ts";
import { ApiError } from "./domain.ts";
import { RelayService } from "./service.ts";
export { database } from "./database.ts";
export async function authenticatedAccount(): Promise<{
  auth: AuthService;
  token: string;
  user: AuthUser;
}> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const auth = new AuthService(database());
  const user = await auth.userForSession(token);
  if (!user || !token)
    throw new ApiError(401, "Sign in to open your RelayForge workspace.");
  return { auth, token, user };
}
export async function authenticatedService(): Promise<RelayService> {
  const { user } = await authenticatedAccount();
  return new RelayService(database(), user.id, Date.now, Math.random, user);
}
