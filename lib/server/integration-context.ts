import { authenticatedAccount, database } from "./context.ts";
import { IntegrationService } from "./integrations.ts";
import { RelayService } from "./service.ts";

export async function authenticatedIntegrations() {
  const { user } = await authenticatedAccount();
  const db = database();
  const relay = new RelayService(db, user.id, Date.now, Math.random, user);
  await relay.initialize();
  return { integrations: new IntegrationService(db, user.id), relay };
}
