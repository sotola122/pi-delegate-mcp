import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  lstatSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertPathsAllowed,
  canApplyDelivery,
  matchesScopePattern,
  isUnsafeRepoPath,
} from "../../src/workspace/scope.js";
import { archiveUntrackedEntry } from "../../src/workspace/manifest.js";
import { createResultPatch } from "../../src/workspace/patch.js";
import { DelegateError } from "../../src/core/errors.js";
import { execFileSync } from "node:child_process";

describe("scope helpers", () => {
  it("matches directory prefixes and exact files", () => {
    expect(matchesScopePattern("src/a.ts", "src")).toBe(true);
    expect(matchesScopePattern("src/a.ts", "src/")).toBe(true);
    expect(matchesScopePattern("src/a.ts", "src/*")).toBe(true);
    expect(matchesScopePattern("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesScopePattern("test/a.ts", "src")).toBe(false);
  });

  it("detects unsafe paths", () => {
    expect(isUnsafeRepoPath("../etc/passwd")).toBe(true);
    expect(isUnsafeRepoPath("/etc/passwd")).toBe(true);
    expect(isUnsafeRepoPath("src/ok.ts")).toBe(false);
  });

  it("enforces inScope and outOfScope", () => {
    expect(() =>
      assertPathsAllowed(["src/a.ts", "docs/x.md"], ["src"], undefined),
    ).toThrow(/not in inScope/);
    expect(() =>
      assertPathsAllowed(["src/a.ts"], undefined, ["src"]),
    ).toThrow(/outOfScope/);
    expect(() =>
      assertPathsAllowed(["src/a.ts"], ["src"], ["docs"]),
    ).not.toThrow();
  });

  it("rejects traversal even without scope lists", () => {
    expect(() => assertPathsAllowed(["../x"])).toThrow(DelegateError);
  });

  it("canApplyDelivery only on success+apply", () => {
    expect(canApplyDelivery("apply", "success")).toBe(true);
    expect(canApplyDelivery("apply", "failed")).toBe(false);
    expect(canApplyDelivery("apply", "cancelled")).toBe(false);
    expect(canApplyDelivery("apply", "incomplete")).toBe(false);
    expect(canApplyDelivery("patch", "success")).toBe(false);
  });
});

describe("archiveUntrackedEntry symlink safety", () => {
  let dir: string;
  let secret: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-manifest-"));
    secret = join(dir, "secret.txt");
    writeFileSync(secret, "TOP_SECRET\n", { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives symlinks without copying target contents", () => {
    const ws = join(dir, "ws");
    const out = join(dir, "out");
    mkdirSync(ws, { recursive: true });
    mkdirSync(out, { recursive: true });
    // In-workspace target
    writeFileSync(join(ws, "secret.txt"), "TOP_SECRET\n", { mode: 0o600 });
    symlinkSync("secret.txt", join(ws, "leak"));

    const omitted = archiveUntrackedEntry(ws, "leak", out);
    expect(omitted).toBeNull();

    const archived = join(out, "leak");
    const st = lstatSync(archived);
    expect(st.isSymbolicLink()).toBe(true);
    expect(st.isFile()).toBe(false);
  });

  it("rejects escaping symlinks", () => {
    const ws = join(dir, "ws-esc");
    const out = join(dir, "out-esc");
    mkdirSync(ws, { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(secret, join(ws, "leak"));

    const omitted = archiveUntrackedEntry(ws, "leak", out);
    expect(omitted).toMatch(/^escape:/);
    expect(existsSync(join(out, "leak"))).toBe(false);
  });

  it("skips path traversal relatives", () => {
    const ws = join(dir, "ws2");
    const out = join(dir, "out2");
    mkdirSync(ws, { recursive: true });
    mkdirSync(out, { recursive: true });
    expect(archiveUntrackedEntry(ws, "../secret.txt", out)).toMatch(/^unsafe:/);
  });
});

describe("createResultPatch scope enforcement", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-patch-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "keep.txt"), "a\n");
    execFileSync("git", ["add", "keep.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects patches that touch outOfScope paths", () => {
    writeFileSync(join(repo, "keep.txt"), "b\n");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "x.md"), "nope\n");
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const out = join(repo, "result.patch");
    expect(() =>
      createResultPatch(repo, baseline, out, {
        inScope: ["keep.txt"],
        outOfScope: ["docs"],
      }),
    ).toThrow(/not in inScope|outOfScope/);
  });

  it("allows in-scope-only changes", () => {
    writeFileSync(join(repo, "keep.txt"), "b\n");
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const out = join(repo, "result.patch");
    createResultPatch(repo, baseline, out, { inScope: ["keep.txt"] });
    expect(readFileSync(out, "utf8")).toContain("keep.txt");
  });
});
