"use client";

// React
import { useActionState } from "react";

// Header
import { PrimaryHeader } from "@/components/marketing/headers/Headers";

// Components
import { Button } from "@/components/ui/button";

// Actions
import { retryProvisioning } from "@/app/actions/actions";

// Types
import { State } from "@/types/server/serverActionState";

/**
 * Shown when a user signed in to Supabase but their account records
 * (user, household, membership) failed to save in our database.
 * Lets them retry instead of being stuck half signed up.
 */
export default function SetupIncompletePage() {
  const [state, formAction, isPending] = useActionState<State>(
    retryProvisioning,
    null
  );

  return (
    <section className="h-screen w-screen flex items-center justify-center">
      <div className="flex flex-col items-center w-[90%] max-w-xl gap-8 text-center">
        <PrimaryHeader label="We couldn't finish setting up your account" />
        <p className="text-muted-foreground">
          You're signed in, but we hit a problem saving your account details.
          Nothing was lost. Try again, and if it keeps happening, wait a minute
          before trying once more.
        </p>

        {state?.status === "error" && (
          <p role="alert" className="text-[#c92a2a] font-medium">
            {state.message}
          </p>
        )}

        <form action={formAction}>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Setting up…" : "Try again"}
          </Button>
        </form>

        <a href="/" className="text-sm underline underline-offset-4">
          Go back to home
        </a>
      </div>
    </section>
  );
}
