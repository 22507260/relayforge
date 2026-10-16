import { authenticatedIntegrations } from "../../../../lib/server/integration-context";
import { readIntegrationJson } from "../../../../lib/server/integrations";
import { assertSameOrigin, json, route } from "../../../../lib/server/http";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const { id } = await context.params;
    const { integrations, relay } = await authenticatedIntegrations();
    const connection = await integrations.updateEnabled(
      id,
      await readIntegrationJson(request),
    );
    return json({ connection, snapshot: await relay.snapshot() });
  });
}
