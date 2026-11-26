// Drizzle
import { db } from "@/drizzle/db";
import { user } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

// Utils
import { getServerErrorMessage } from "@/utils/api-helpers/errors/getServerErrorMessage";
import { ensureProvisioned } from "@/features/auth/utils/provisioning";

// Types
import { SupabaseUserSyncData } from "@/features/auth/types/callback";

/**
 * Provisions the user in Postgres (user row, household and admin membership)
 * and returns the user with their subscriptions.
 *
 * @returns The user with subscriptions, or null if provisioning failed.
 * A null result is recoverable: the user's next authenticated request
 * retries provisioning (see `ensureProvisionedIfMissing`).
 */
export async function upsertUser(currentUser: SupabaseUserSyncData) {
  try {
    await ensureProvisioned(currentUser);

    return await db.query.user.findFirst({
      where: eq(user.userId, currentUser.id),
      with: { subscriptions: true },
    });
  } catch (err) {
    console.error(getServerErrorMessage(err), err);
    return null;
  }
}
