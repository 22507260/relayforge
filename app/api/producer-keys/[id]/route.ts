import { authenticatedIntegrations } from "../../../../lib/server/integration-context";
import { assertSameOrigin, json, route } from "../../../../lib/server/http";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const { id } = await context.params;
    const { integrations } = await authenticatedIntegrations();
    await integrations.revokeProducerKey(id);
    return json({ keys: await integrations.listProducerKeys() });
  });
}
