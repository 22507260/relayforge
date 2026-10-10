import { authenticatedService } from "../../../lib/server/context";
import { json, route } from "../../../lib/server/http";

export async function GET(): Promise<Response> {
  return route(async () => json(await (await authenticatedService()).snapshot()));
}
