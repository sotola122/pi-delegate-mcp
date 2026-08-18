import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseUpdateArgs,
  updateCommand,
  PACKAGE_NAME,
  type NpmRunner,
} from "../../src/cli/update.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseUpdateArgs", () => {
  it("defaults to latest", () => {
    expect(parseUpdateArgs([])).toEqual({ check: false, versionSpec: "latest" });
  });

  it("parses --check and version", () => {
    expect(parseUpdateArgs(["--check"])).toEqual({
      check: true,
      versionSpec: "latest",
    });
    expect(parseUpdateArgs(["0.2.1"])).toEqual({
      check: false,
      versionSpec: "0.2.1",
    });
    expect(parseUpdateArgs(["@0.3.0", "--check"])).toEqual({
      check: true,
      versionSpec: "0.3.0",
    });
  });

  it("rejects unknown flags", () => {
    expect(() => parseUpdateArgs(["--force"])).toThrow(/Unknown update flag/);
  });
});

describe("updateCommand", () => {
  it("--check exits 0 when up to date", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const codes: number[] = [];
    const npm: NpmRunner = (args) => {
      expect(args).toEqual(["view", PACKAGE_NAME, "version"]);
      return {
        status: 0,
        stdout: "0.2.1\n",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
        error: undefined,
      };
    };
    updateCommand(["--check"], {
      npm,
      installedVersion: () => "0.2.1",
      setExitCode: (c) => codes.push(c),
    });
    expect(codes).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/up to date/);
  });

  it("--check exits 1 when update available", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const codes: number[] = [];
    const npm: NpmRunner = () => ({
      status: 0,
      stdout: "0.3.0\n",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
      error: undefined,
    });
    updateCommand(["--check"], {
      npm,
      installedVersion: () => "0.2.1",
      setExitCode: (c) => codes.push(c),
    });
    expect(codes).toEqual([1]);
  });

  it("runs npm install -g with target version", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: string[][] = [];
    const codes: number[] = [];
    const npm: NpmRunner = (args, opts) => {
      calls.push(args);
      expect(opts?.stdio).toBe("inherit");
      return {
        status: 0,
        stdout: "",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
        error: undefined,
      };
    };
    updateCommand(["0.2.1"], {
      npm,
      installedVersion: () => "0.2.0",
      setExitCode: (c) => codes.push(c),
    });
    expect(calls).toEqual([["install", "-g", `${PACKAGE_NAME}@0.2.1`]]);
    expect(codes).toEqual([]);
  });

  it("fails with hint when npm install fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const codes: number[] = [];
    const npm: NpmRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "403 Forbidden",
      pid: 1,
      output: [],
      signal: null,
      error: undefined,
    });
    updateCommand([], {
      npm,
      installedVersion: () => "0.2.1",
      setExitCode: (c) => codes.push(c),
    });
    expect(codes).toEqual([1]);
    expect(err.mock.calls.flat().join("\n")).toMatch(/read:packages/);
  });
});
