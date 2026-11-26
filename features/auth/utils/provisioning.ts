// Drizzle
import { db } from "@/drizzle/db";
import { user, household, householdMember } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

// Utils
import { createHouseholdName } from "@/utils/helper-functions/formatting/createHouseholdName";
import { getServerErrorMessage } from "@/utils/api-helpers/errors/getServerErrorMessage";

// Types
import { SupabaseUserSyncData } from "@/features/auth/types/callback";

/**
 * Provisioning keeps Postgres in step with Supabase Auth.
 *
 * Supabase creates the auth user before any of our code runs, and the two
 * systems cannot share a transaction. So instead of trying to undo a Supabase
 * signup when our insert fails, every entry point (OAuth callback, password
 * sign-up, password login, authenticated API requests, protected pages) calls
 * these functions. They are idempotent and keyed on the Supabase user ID, so a
 * user whose first provisioning failed is repaired on their next request.
 */

const HOUSEHOLD_MEMBER_USER_ID_KEY = "HouseholdMember_user_id_key";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

/**
 * Creates or updates the User row and, if the user has no membership yet,
 * creates their Household and ADMIN HouseholdMember. All in one transaction,
 * so a failure never leaves a user without a household.
 *
 * Retries transient failures (dropped connections, timeouts) with backoff.
 *
 * @throws The last error if every attempt fails.
 */
export const ensureProvisioned = async (currentUser: SupabaseUserSyncData) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await provisionOnce(currentUser);
      return;
    } catch (err) {
      /**
       * Concurrent requests for the same user can both try to create a
       * membership. The unique index makes the loser fail and roll back. The
       * winner already provisioned this user, so this counts as success.
       */
      if (isUniqueViolation(err, HOUSEHOLD_MEMBER_USER_ID_KEY)) return;

      /**
       * Any other unique violation (e.g. the email belongs to a different
       * user_id) fails the same way every time, so don't retry it.
       */
      if (isUniqueViolation(err)) throw err;

      lastError = err;
      console.error(
        `Provisioning attempt ${attempt}/${MAX_ATTEMPTS} failed for user ${currentUser.id}:`,
        getServerErrorMessage(err)
      );
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastError;
};

/**
 * Returns true if the user already has a household membership.
 * One indexed lookup on HouseholdMember.user_id.
 */
export const isProvisioned = async (userId: string) => {
  const rows = await db
    .select({ householdId: householdMember.householdId })
    .from(householdMember)
    .where(eq(householdMember.userId, userId))
    .limit(1);
  return rows.length !== 0;
};

/**
 * Self-healing check for authenticated requests: provisions the user only
 * when their membership is missing. Cheap on the happy path (one lookup).
 *
 * @returns true if the user is provisioned when this returns, false if
 * provisioning was needed and failed.
 */
export const ensureProvisionedIfMissing = async (
  currentUser: SupabaseUserSyncData
): Promise<boolean> => {
  try {
    if (await isProvisioned(currentUser.id)) return true;

    console.warn(
      `User ${currentUser.id} has no household membership. Provisioning now.`
    );
    await ensureProvisioned(currentUser);
    return true;
  } catch (err) {
    console.error(
      `Self-healing provisioning failed for user ${currentUser.id}:`,
      getServerErrorMessage(err),
      err
    );
    return false;
  }
};

const provisionOnce = async (currentUser: SupabaseUserSyncData) => {
  const { id: userId, email = "" } = currentUser;
  const fullName = currentUser.user_metadata?.full_name?.trim() || undefined;

  await db.transaction(async (tx) => {
    /**
     * Upsert the user. Only overwrite name and email when Supabase has a
     * value, so a password login (no full_name) doesn't erase an OAuth name.
     */
    await tx
      .insert(user)
      .values({ userId, email, fullName: fullName ?? "Unknown" })
      .onConflictDoUpdate({
        target: user.userId,
        set: {
          ...(email ? { email } : {}),
          ...(fullName ? { fullName } : {}),
        },
      });

    /**
     * Returning users already have a membership: nothing more to do.
     */
    const existing = await tx
      .select({ householdId: householdMember.householdId })
      .from(householdMember)
      .where(eq(householdMember.userId, userId))
      .limit(1);
    if (existing.length !== 0) return;

    /**
     * First login: create the household and make the user its admin.
     */
    const [{ householdId }] = await tx
      .insert(household)
      .values({
        householdId: crypto.randomUUID(),
        householdName: createHouseholdName(fullName, email || undefined),
        createdByUserId: userId,
      })
      .returning({ householdId: household.householdId });

    await tx.insert(householdMember).values({
      householdMemberId: crypto.randomUUID(),
      fullName: fullName ?? "Unknown",
      email: email || null,
      role: "ADMIN",
      userId,
      householdId,
    });
  });
};

/**
 * Returns true if the error (or the driver error Drizzle wraps in `cause`)
 * is a Postgres unique violation (23505), optionally on a specific constraint.
 */
const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const candidates = [err, (err as { cause?: unknown })?.cause];
  return candidates.some((e) => {
    const pgErr = e as { code?: string; constraint?: string } | undefined;
    return (
      pgErr?.code === "23505" &&
      (constraint === undefined || pgErr.constraint === constraint)
    );
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
