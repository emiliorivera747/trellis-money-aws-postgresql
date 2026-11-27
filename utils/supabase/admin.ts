import { createClient, type User } from "@supabase/supabase-js";

// Utils
import { getUserByEmail } from "@/utils/drizzle/user/user";

/**
 * Supabase admin client, authenticated with the service-role key.
 *
 * The service-role key bypasses all access rules, so this client is ONLY for
 * server-side admin work: listing, looking up and deleting auth users. It
 * never reads or writes the visitor's session cookies, so it can't act as a
 * user or leak admin rights into a user's request.
 *
 * For anything done on behalf of the signed-in user, use `createClient` from
 * `@/utils/supabase/server`, which uses the anon key and the session cookies.
 */
export const createAdminClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.NEXT_SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRoleKey)
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_SUPABASE_SERVICE_ROLE must be set to use the Supabase admin client."
    );

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
};

const PAGE_SIZE = 1000;

/**
 * Yields every Supabase auth user, one page at a time.
 * `auth.admin.listUsers()` returns only the first page (50 users) unless you
 * page through it, so always use this instead of a bare `listUsers()` call.
 */
export async function* listAllAuthUsers(
  admin = createAdminClient()
): AsyncGenerator<User[]> {
  let page: number | null = 1;

  while (page) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    });
    if (error) throw error;

    if (data.users.length > 0) yield data.users;

    // Stop on a short page too, in case nextPage is missing from the response.
    page = data.users.length < PAGE_SIZE ? null : data.nextPage ?? null;
  }
}

/**
 * Finds a Supabase auth user by email.
 *
 * Fast path: look up the user ID in Postgres, then fetch that one auth user.
 * Fallback: page through every auth user, for accounts whose Postgres row is
 * missing or has a different email.
 */
export const findAuthUserByEmail = async (
  email: string
): Promise<User | null> => {
  const admin = createAdminClient();
  const normalized = email.trim().toLowerCase();

  const dbUser = await getUserByEmail(normalized);
  if (dbUser) {
    const { data, error } = await admin.auth.admin.getUserById(dbUser.userId);
    if (!error && data.user?.email?.toLowerCase() === normalized)
      return data.user;
  }

  for await (const users of listAllAuthUsers(admin)) {
    const match = users.find((u) => u.email?.toLowerCase() === normalized);
    if (match) return match;
  }

  return null;
};
