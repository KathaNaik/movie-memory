import { signOut } from "@/auth";

export function SignOutButton() {
  return (
    <form
      action={async () => {
        "use server";
        // Deletes the database session and clears the cookie.
        await signOut({ redirectTo: "/" });
      }}
    >
      <button
        type="submit"
        className="shrink-0 rounded-full border border-black bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
      >
        Sign out
      </button>
    </form>
  );
}
