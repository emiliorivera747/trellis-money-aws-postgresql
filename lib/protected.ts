// lib/protected.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { ensureProvisionedIfMissing } from "@/features/auth/utils/provisioning";

export async function withAuth(
  request: NextRequest,
  handler: (req: NextRequest, user: any) => Promise<NextResponse>
) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  /**
   * Self-heal: if the user is signed in to Supabase but their Postgres
   * records are missing (an earlier sign-up failed partway), create them now.
   * One indexed lookup when everything is already in place.
   */
  const provisioned = await ensureProvisionedIfMissing(user);
  if (!provisioned)
    return NextResponse.json(
      {
        error:
          "We couldn't finish setting up your account. Please try again in a moment.",
      },
      { status: 503 }
    );

  return handler(request, user);
}
