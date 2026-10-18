import { livenessResponse } from "../../../../lib/server/health";
import { route } from "../../../../lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(async () => livenessResponse());
}
