import { authenticatedService } from "../../../lib/server/context";
import { json, parseDeliveryQuery, route } from "../../../lib/server/http";

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const service = await authenticatedService();
    return json(await service.listDeliveries(parseDeliveryQuery(request)));
  });
}
