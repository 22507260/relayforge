import { authenticatedIntegrations } from "../../../../../lib/server/integration-context";
import { readIntegrationJson } from "../../../../../lib/server/integrations";
import { assertSameOrigin, json, route } from "../../../../../lib/server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const { id } = await context.params;
    const { integrations, relay } = await authenticatedIntegrations();
    const result = await integrations.rotateSigningKey(
      id,
      await readIntegrationJson(request),
    );
    return json({ ...result, snapshot: await relay.snapshot() });
  });
}
