import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";

// Drizzle
import { db } from "@/drizzle/db";
import { user, householdMember } from "@/drizzle/schema";

// Utils
import { listAllAuthUsers } from "@/utils/supabase/admin";
import { ensureProvisioned } from "@/features/auth/utils/provisioning";
import { ErrorResponse } from "@/utils/api-helpers/api-responses/response";
import { getServerErrorMessage } from "@/utils/api-helpers/errors/getServerErrorMessage";

/**
 * Cron job that checks Supabase Auth and Postgres are in sync.
 * Scheduled in vercel.json at 10:00 UTC (2 AM PST / 3 AM PDT).
 *
 * Steps:
 * 1. Pages through every Supabase auth user.
 * 2. For each page, looks up the matching User rows and household memberships.
 * 3. Repairs any auth user with no User row, no membership, or a different
 *    email, using the same idempotent `ensureProvisioned` that login uses.
 * 4. Reports Postgres users with no Supabase account ("orphaned"). These are
 *    never deleted automatically, because deleting a user cascades into
 *    households and accounts.
 *
 * @param req - Incoming `NextRequest`.
 * @returns A `Response` with a sync summary or an error message.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("Running Supabase/Postgres user sync...");

    const authIds = new Set<string>();
    const repaired: string[] = [];
    const failed: { userId: string; error: string }[] = [];

    for await (const page of listAllAuthUsers()) {
      const ids = page.map((u) => u.id);
      ids.forEach((id) => authIds.add(id));

      /**
       * One query per page: each user row plus their membership, if any.
       * HouseholdMember.user_id is unique, so the join yields one row per user.
       */
      const rows = await db
        .select({
          userId: user.userId,
          email: user.email,
          memberUserId: householdMember.userId,
        })
        .from(user)
        .leftJoin(householdMember, eq(householdMember.userId, user.userId))
        .where(inArray(user.userId, ids));
      const byId = new Map(rows.map((r) => [r.userId, r]));

      for (const authUser of page) {
        const row = byId.get(authUser.id);
        const emailMatches =
          !authUser.email ||
          row?.email.toLowerCase() === authUser.email.toLowerCase();
        if (row?.memberUserId && emailMatches) continue;

        try {
          await ensureProvisioned({
            id: authUser.id,
            email: authUser.email,
            user_metadata: authUser.user_metadata ?? {},
          });
          repaired.push(authUser.id);
        } catch (err) {
          failed.push({ userId: authUser.id, error: getServerErrorMessage(err) });
        }
      }
    }

    // The other direction: Postgres users whose Supabase account is gone.
    const dbUsers = await db.select({ userId: user.userId }).from(user);
    const orphaned = dbUsers
      .map((u) => u.userId)
      .filter((id) => !authIds.has(id));

    if (repaired.length || failed.length || orphaned.length) {
      console.warn("Supabase/Postgres user sync found drift:", {
        repaired,
        failed,
        orphaned,
      });
    }

    return NextResponse.json({
      status: failed.length ? "partial" : "success",
      message: `Checked ${authIds.size} auth users: ${repaired.length} repaired, ${failed.length} failed, ${orphaned.length} orphaned in Postgres`,
      authUsers: authIds.size,
      repaired,
      failed,
      orphaned,
    });
  } catch (error) {
    return ErrorResponse(error);
  }
}
