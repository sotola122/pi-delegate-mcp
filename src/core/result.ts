export interface AcceptanceEvidence {
  check: string;
  status: "pass" | "fail" | "unknown";
  evidence?: string;
}

export interface AttemptRecord {
  backend?: "cli" | "sdk" | "fake";
  sdkVersion?: string;
  provider?: string;
  model: string;
  thinking?: string;
  completion?: string;
  agentStarted?: boolean;
  agentEnded?: boolean;
  toolCalls?: number;
  toolFailures?: number;
  /** @deprecated Use completion instead */
  exitCode?: number | null;
  status: string;
  durationMs: number;
  error?: { code: string; message: string };
}

export interface DelegateResult {
  runId: string;
  status: "success" | "incomplete" | "failed" | "cancelled";
  profile: "review" | "verify" | "implement" | "no-tools";
  provider: string;
  model: string;
  thinking: string;
  workspace?: string;
  workspaceMode?: "in-place" | "worktree";
  delivery?: "none" | "patch" | "apply";
  output: string;
  acceptance: AcceptanceEvidence[];
  sideEffects: string[];
  artifacts: Array<{ kind: string; path: string }>;
  attempts: AttemptRecord[];
  durationMs: number;
  code?: string;
  message?: string;
}

const HEADINGS: Record<string, string> = {
  review: "# Review Result",
  verify: "# Verify Result",
  implement: "# Implement Result",
  "no-tools": "# Judgment Result",
};

export function requiredHeading(profile: string): string {
  return HEADINGS[profile] ?? "# Result";
}

export function outputHasHeading(output: string, profile: string): boolean {
  const heading = requiredHeading(profile);
  return output.includes(heading);
}

export function parseAcceptanceEvidence(
  output: string,
  checks: string[],
): AcceptanceEvidence[] {
  if (checks.length === 0) return [];
  return checks.map((check) => {
    const escaped = check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `${escaped}[\\s\\S]{0,200}?(pass|fail|unknown|✓|✗|✅|❌)`,
      "i",
    );
    const m = output.match(re);
    if (!m) {
      return { check, status: "unknown" as const };
    }
    const token = m[1]!.toLowerCase();
    let status: AcceptanceEvidence["status"] = "unknown";
    if (token === "pass" || token === "✓" || token === "✅") status = "pass";
    else if (token === "fail" || token === "✗" || token === "❌") status = "fail";
    return { check, status, evidence: m[0]!.slice(0, 200) };
  });
}

export function finalizeStatusFromOutcome(opts: {
  completion: string;
  cancelled?: boolean;
  output: string;
  profile: string;
  acceptance: AcceptanceEvidence[];
  requireHeading: boolean;
  agentStarted?: boolean;
  agentEnded?: boolean;
}): DelegateResult["status"] {
  if (opts.cancelled || opts.completion === "cancelled") return "cancelled";
  if (
    opts.completion === "provider_error" ||
    opts.completion === "tool_error" ||
    opts.completion === "timeout" ||
    opts.completion === "internal_error"
  ) {
    return "failed";
  }
  if (opts.requireHeading && !outputHasHeading(opts.output, opts.profile)) {
    return "incomplete";
  }
  if (opts.acceptance.length > 0 && opts.acceptance.some((a) => a.status === "unknown")) {
    return "incomplete";
  }
  if (opts.acceptance.some((a) => a.status === "fail")) return "incomplete";
  if (opts.completion === "incomplete") return "incomplete";
  if (opts.agentStarted === false || opts.agentEnded === false) {
    return "incomplete";
  }
  return "success";
}

/** @deprecated Prefer finalizeStatusFromOutcome */
export function finalizeStatus(
  exitCode: number | null,
  cancelled: boolean,
  output: string,
  profile: string,
  acceptance: AcceptanceEvidence[],
  requireHeading: boolean,
): DelegateResult["status"] {
  return finalizeStatusFromOutcome({
    completion:
      cancelled
        ? "cancelled"
        : exitCode !== 0
          ? "provider_error"
          : "completed",
    cancelled,
    output,
    profile,
    acceptance,
    requireHeading,
    agentStarted: true,
    agentEnded: exitCode === 0 && !cancelled,
  });
}
