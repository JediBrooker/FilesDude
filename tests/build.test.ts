import assert from "node:assert/strict";
import test from "node:test";
import { isNewerBuild } from "../lib/build";

test("a page offers to reload only when the server runs a different, known build", () => {
  const page = { version: "0.2.0", commit: "09e049b" };
  assert.equal(isNewerBuild({ version: "0.2.0", commit: "09e049b" }, page), false);
  assert.equal(isNewerBuild({ version: "0.2.0", commit: "1a2b3c4" }, page), true);
  assert.equal(isNewerBuild({ version: "0.3.0", commit: "" }, page), true, "a new version, even without a commit");
  assert.equal(isNewerBuild({ version: "0.2.0", commit: "" }, page), false, "an unknown commit never counts");
  assert.equal(isNewerBuild({ version: "0.2.0", commit: "1a2b3c4" }, { version: "0.2.0", commit: "" }), false);
  // Signed-out responses carry no build, and anything malformed is ignored.
  assert.equal(isNewerBuild(undefined, page), false);
  assert.equal(isNewerBuild(null, page), false);
  assert.equal(isNewerBuild({ version: 3 } as never, page), false);
});
