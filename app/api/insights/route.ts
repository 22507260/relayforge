import { authenticatedAccount, database } from "../../../lib/server/context";
import { json, route } from "../../../lib/server/http";
import {
  InsightsService,
  parseInsightsQuery,
} from "../../../lib/server/insights";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const { user } = await authenticatedAccount();
    return json(
      await new InsightsService(database(), user.id).read(
        parseInsightsQuery(request),
      ),
    );
  });
}
