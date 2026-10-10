import { authenticatedService } from "../../../../lib/server/context";
import { ApiError } from "../../../../lib/server/domain";
import { json, route } from "../../../../lib/server/http";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ApiError(400, "Invalid delivery identifier.");
    return json(await (await authenticatedService()).detail(id));
  });
}
