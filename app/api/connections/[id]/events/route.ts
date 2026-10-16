import { z } from "zod";
import { authenticatedService } from "../../../../../lib/server/context";
import { ApiError } from "../../../../../lib/server/domain";
import { assertSameOrigin, json, route } from "../../../../../lib/server/http";
import { readIntegrationJson } from "../../../../../lib/server/integrations";

const eventSchema = z
  .object({
    eventType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
    payload: z.record(z.unknown()),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    assertSameOrigin(request);
    const service = await authenticatedService();
    const { id } = await context.params;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new ApiError(400, "Invalid connection identifier.");
    const parsed = eventSchema.safeParse(await readIntegrationJson(request));
    if (!parsed.success)
      throw new ApiError(
        400,
        "Check the event type, JSON payload and idempotency key.",
      );
    await service.initialize();
    const acceptance = await service.enqueue(
      id,
      parsed.data.eventType,
      parsed.data.payload,
      parsed.data.idempotencyKey,
    );
    return json({ ...acceptance, snapshot: await service.snapshot() }, 202);
  });
}
