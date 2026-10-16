import { authenticatedIntegrations } from "../../../lib/server/integration-context";
import { readIntegrationJson } from "../../../lib/server/integrations";
import { assertSameOrigin, json, route } from "../../../lib/server/http";

export async function GET(): Promise<Response> {
  return route(async () => {
    const { integrations } = await authenticatedIntegrations();
    return json({
      connections: await integrations.listConnections(),
      configuration: await integrations.configuration(),
    });
  });
}
export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const { integrations, relay } = await authenticatedIntegrations();
    const result = await integrations.createConnection(
      await readIntegrationJson(request),
    );
    return json({ ...result, snapshot: await relay.snapshot() }, 201);
  });
}
