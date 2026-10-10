import { authenticatedService } from "../../../lib/server/context";
import { assertSameOrigin, json, parseAction, route } from "../../../lib/server/http";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const service = await authenticatedService();
    const action = await parseAction(request);
    return json(await service.action(action));
  });
}
