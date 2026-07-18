import { signIn } from "@/lib/reviewAuth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  // callbackUrl may carry a review page path including its shareToken query
  // param — preserving it through OAuth keeps external reviewers' access
  // intact after the sign-in round trip.
  const redirectTo = callbackUrl ?? "/";
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--background-panel)] p-8 text-center shadow-[var(--shadow-cinematic)]">
        <h1 className="mb-1 font-[family-name:var(--font-display)] text-2xl font-bold text-[var(--foreground)]">
          PrVod
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-[var(--foreground-muted)]">
          Sign in with GitHub to draft and submit review comments from a walkthrough.
        </p>

        <form
          action={async (formData: FormData) => {
            "use server";
            const target = formData.get("redirectTo") as string;
            await signIn("github", { redirectTo: target });
          }}
        >
          <input type="hidden" name="redirectTo" value={redirectTo} />
          <button
            type="submit"
            className="cine-transition inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-6 py-3 text-[0.9375rem] font-medium text-white hover:opacity-90"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Sign in with GitHub
          </button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-[var(--foreground-soft)]">
          Signing in only unlocks commenting — viewing access is controlled by
          the review link you were given.
        </p>
      </div>
    </div>
  );
}
