import assert from "node:assert/strict";
import test from "node:test";
import { canChangeOwnership, capabilitiesFrom, includesChown, privileged } from "../lib/privileges";

test("capabilities are read from the process's status", () => {
  // FilesDude's account, as installed: CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_DAC_READ_SEARCH, CAP_FOWNER, CAP_FSETID.
  const installed = capabilitiesFrom("Name:\tnode\nCapInh:\t000000000000001f\nCapPrm:\t000000000000001f\nCapEff:\t000000000000001f\n");
  assert.equal(installed, BigInt(0x1f));
  assert.equal(includesChown(installed), true);
  // Reading and writing everything, but not changing owners.
  assert.equal(includesChown(capabilitiesFrom("CapEff:\t000000000000001e\n")), false);
  assert.equal(capabilitiesFrom("CapEff:\t0000000000000000\n"), BigInt(0));
  for (const odd of ["", "CapEff:", "CapEff:\tzz", "CapEff:\t0x1f", "CapEff:\t00000000000000001f"]) assert.equal(capabilitiesFrom(odd), BigInt(0), odd);
});

test("this process's own privileges", () => {
  const root = process.getuid?.() === 0;
  if (root) {
    assert.equal(canChangeOwnership(), true);
    assert.equal(privileged(), true);
  } else if (process.platform !== "linux") {
    assert.equal(canChangeOwnership(), false);
    assert.equal(privileged(), false);
  }
});
