import { AuditService } from "../../../lib/server/audit";
import { authenticatedAccount, database } from "../../../lib/server/context";
import { json, parseAuditQuery, route } from "../../../lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const { user } = await authenticatedAccount();
    return json(
      await new AuditService(database(), user.id).list(
        parseAuditQuery(request),
      ),
    );
  });
}
