/**
 * Phase 2A Kernel Reference — Golden Vector CI Gate
 *
 * Validates the normative C99 reference implementation:
 * 1. SHA-256 self-test against NIST FIPS 180-4 vectors (root of trust)
 * 2. Golden vector verification (protocol-kernel correctness)
 *
 * This test compiles and runs the reference binary via WSL (Ubuntu-24.04).
 * Tests run on Windows; the reference is a Linux C99 binary.
 *
 * The reference implementation IS the spec. If this test fails, either:
 * - The C99 source was modified (investigate the change)
 * - The build environment changed (compiler, platform)
 * - A genuine bug was introduced
 *
 * In all cases, do NOT update the golden vectors to make the test pass.
 * Fix the root cause.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const EVIDENCE_DIR = resolve(__dirname, "../../evidence/phase2a");
const REF_SOURCE = resolve(EVIDENCE_DIR, "phase2a_kernel_ref_v1.c");

/* WSL path for the evidence directory */
const WSL_EVIDENCE_DIR =
  "/mnt/c/Users/theyc/Hive\\ AI/HivePoA/evidence/phase2a";
const WSL_BINARY = `${WSL_EVIDENCE_DIR}/phase2a_kernel_ref_v1`;
const WSL_SOURCE = `${WSL_EVIDENCE_DIR}/phase2a_kernel_ref_v1.c`;

/**
 * Run a command in WSL Ubuntu-24.04.
 * Returns stdout as string. Throws on nonzero exit.
 */
function wsl(cmd: string): string {
  return execSync(`wsl -d Ubuntu-24.04 -- bash -c "${cmd}"`, {
    encoding: "utf-8",
    timeout: 30_000,
  });
}

/**
 * Check if WSL with a C compiler is available.
 */
function hasWslCompiler(): boolean {
  try {
    wsl("cc --version");
    return true;
  } catch {
    return false;
  }
}

describe("Phase 2A kernel reference", () => {
  const wslAvailable = hasWslCompiler();

  beforeAll(() => {
    if (!wslAvailable) return;
    if (!existsSync(REF_SOURCE)) {
      throw new Error(
        `Reference source not found: ${REF_SOURCE}\n` +
          "The Phase 2A kernel reference is a required artifact.",
      );
    }

    // Compile the reference implementation in WSL
    wsl(
      `cd ${WSL_EVIDENCE_DIR} && cc -std=c99 -O2 -o phase2a_kernel_ref_v1 phase2a_kernel_ref_v1.c`,
    );
  });

  it("source file exists", () => {
    expect(existsSync(REF_SOURCE)).toBe(true);
  });

  it("SHA-256 self-test passes (NIST FIPS 180-4)", () => {
    if (!wslAvailable) {
      console.log("SKIP: WSL or C compiler not available");
      return;
    }

    const result = wsl(`${WSL_BINARY} --selftest`);

    expect(result).toContain("NIST: empty string");
    expect(result).toContain("PASS");
    expect(result).toContain("ALL PASS");
    expect(result).not.toContain("FAIL");
  });

  it("golden vector verification passes (kernel contract correctness)", () => {
    if (!wslAvailable) {
      console.log("SKIP: WSL or C compiler not available");
      return;
    }

    const result = wsl(`${WSL_BINARY} --verify`);

    // SHA-256 root of trust
    expect(result).toContain("SHA-256: ALL PASS");

    // Golden vector verification
    expect(result).toContain("class=1 stage=0");
    expect(result).toContain("class=2 stage=1");
    expect(result).toContain("class=3 stage=2");
    expect(result).toContain("RESULT: ALL PASS");
    expect(result).not.toContain("FAIL");
  });

  it("golden digests match cross-validated expected values", () => {
    if (!wslAvailable) {
      console.log("SKIP: WSL or C compiler not available");
      return;
    }

    const result = wsl(`${WSL_BINARY} --golden`);

    // Cross-validated against independent implementation (ChatGPT sandbox)
    const expectedDigests = [
      "5c1fc61233c1342b1d77b993ee690bcb03ff26e5acb5dcab927177aef59d5f3a",
      "1adca8b732246c0a2045d27953c717e62d09688b0593befc043105726f3562e1",
      "21c31aebe3efedc19c8c2904b3dabc24742a9adc9a0e0ee59c835f0d79219438",
    ];

    for (const digest of expectedDigests) {
      expect(result).toContain(`digest=${digest}`);
    }
  });
});
