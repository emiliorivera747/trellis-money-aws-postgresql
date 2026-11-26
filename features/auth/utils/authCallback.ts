// Drizzle
import { db } from "@/drizzle/db";
import { user, household, householdMember } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

// Utils
import { getServerErrorMessage } from "@/utils/api-helpers/errors/getServerErrorMessage";
import { createHouseholdName } from "@/utils/helper-functions/formatting/createHouseholdName";

// Types
import { SupabaseUserSyncData } from "@/features/auth/types/callback";

/**
 * Adds or updates a user in the PostgreSQL database via Drizzle.
 */
export async function upsertUser(currentUser: SupabaseUserSyncData) {
  try {
    /**
     * Perform the upsert
     */
    const userDB = await updateOrCreateUser(currentUser);

    /**
     * Get the household
     */
    const doesHouseholdExistRes = await doesHouseholdExist(currentUser.id);

    /**
     * If the user does not exist then we will
     * create a new house and member.
     */
    if (!doesHouseholdExistRes) await createHousehold(currentUser);

    return userDB;
  } catch (err) {
    console.error(getServerErrorMessage(err), err);
    return null;
  }
}

/**
 * Creates a household and assigns the user as an admin member.
 *
 * @param currentUser - User data with ID, email, and metadata.
 *
 * Steps:
 * 1. Generate a household name from the user's full name or email.
 * 2. Create a household and add the user as an admin member.
 *
 * @throws Error if the database transaction fails.
 */
export const createHousehold = async (currentUser: SupabaseUserSyncData) => {
  const { id, email, user_metadata } = currentUser;
  const fullName = user_metadata.full_name?.trim();

  try {
    await insertHouseholdWithAdmin(id, email, fullName);
  } catch (err) {
    /**
     * Concurrent callbacks for the same user (double-clicked magic link,
     * multiple tabs) can both pass the doesHouseholdExist check. The unique
     * index on HouseholdMember.user_id makes the loser's member insert fail,
     * which rolls back its household insert too. The user already has a
     * household from the winning request, so this is a success.
     */
    if (isUniqueViolation(err, HOUSEHOLD_MEMBER_USER_ID_KEY)) return;
    throw err;
  }
};

const HOUSEHOLD_MEMBER_USER_ID_KEY = "HouseholdMember_user_id_key";

/**
 * Returns true if the error (or the driver error Drizzle wraps in `cause`)
 * is a Postgres unique violation (23505) on the given constraint.
 */
const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  const candidates = [err, (err as { cause?: unknown })?.cause];
  return candidates.some((e) => {
    const pgErr = e as { code?: string; constraint?: string } | undefined;
    return pgErr?.code === "23505" && pgErr.constraint === constraint;
  });
};

const insertHouseholdWithAdmin = async (
  id: string,
  email: string | undefined,
  fullName: string | undefined
) => {
  await db.transaction(async (tx) => {
    /**
     * Create Household
     */
    const householdInsert = await tx
      .insert(household)
      .values({
        householdId: crypto.randomUUID(),
        householdName: createHouseholdName(fullName, email),
      })
      .returning({ householdId: household.householdId });

    const householdId = householdInsert[0].householdId;

    /**
     * Create Member
     */
    await tx.insert(householdMember).values({
      householdMemberId: crypto.randomUUID(),
      fullName: fullName || "Unknown",
      role: "ADMIN",
      userId: id,
      householdId,
    });
  });
};

/**
 * Retrieves the household ID for a given user ID.
 *
 * @param userId - The user's unique identifier.
 * @returns A promise resolving to the `household_id` or `null` if not found.
 */
export const doesHouseholdExist = async (userId: string) => {
  const exists = await db
    .select({ householdId: householdMember.householdId })
    .from(householdMember)
    .where(eq(householdMember.userId, userId))
    .limit(1);
  return exists.length !== 0;
};

/**
 * Upserts a user in the database.
 *
 * @param currentUser - User data including ID, email, and metadata.
 * @returns The user record after the upsert operation.
 *
 * Updates or creates a user based on `user_id`. Defaults email to an empty string
 * and name to "Unknown" if not provided.
 */
export const updateOrCreateUser = async (currentUser: SupabaseUserSyncData) => {
  const userId = currentUser.id;
  const email = currentUser.email ?? "";
  const fullName = currentUser.user_metadata?.full_name?.trim() || "Unknown";

  await db
    .insert(user)
    .values({
      userId,
      email,
      fullName,
    })
    .onConflictDoUpdate({
      target: user.userId,
      set: {
        email: currentUser.email ?? "",
        fullName: currentUser.user_metadata.full_name?.trim() || "Unknown",
      },
    });

  const userWithSubs = await db.query.user.findFirst({
    where: eq(user.userId, userId),
    with: { subscriptions: true },
  });

  return userWithSubs;
};
