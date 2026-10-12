import { authenticatedService } from "../../../../lib/server/context";
import {
  assertSameOrigin,
  json,
  parseReplayBatch,
  route,
} from "../../../../lib/server/http";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const service = await authenticatedService();
    const selection = await parseReplayBatch(request);
    return json(await service.replayBatch(selection));
  });
}
