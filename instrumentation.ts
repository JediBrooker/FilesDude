// Runs once when the server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recoverInterruptedCopies } = await import("./lib/files");
  // Not awaited: cleaning up after an interrupted copy shouldn't delay the server becoming ready.
  void recoverInterruptedCopies().catch((error: unknown) => console.error("Could not clean up interrupted copies", error));
}
