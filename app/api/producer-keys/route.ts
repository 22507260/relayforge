import { authenticatedIntegrations } from "../../../lib/server/integration-context";
import { readIntegrationJson } from "../../../lib/server/integrations";
import { assertSameOrigin, json, route } from "../../../lib/server/http";

export async function GET(): Promise<Response> {
  return route(async () => {
    const { integrations } = await authenticatedIntegrations();
    return json({ keys: await integrations.listProducerKeys() });
  });
}
export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const { integrations } = await authenticatedIntegrations();
    return json(
      await integrations.createProducerKey(await readIntegrationJson(request)),
      201,
    );
  });
}
