import { authenticatedAccount, database } from "../../../lib/server/context";
import { json, route } from "../../../lib/server/http";
import {
  OperationsService,
  parseOperationsQuery,
} from "../../../lib/server/operations";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const { user } = await authenticatedAccount();
    const { scope } = parseOperationsQuery(request);
    return json(await new OperationsService(database(), user.id).read(scope));
  });
}
