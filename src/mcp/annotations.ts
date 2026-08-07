export const annotations = {
  review: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Contacts an external model provider.
    openWorldHint: true,
  },
  verify: {
    readOnlyHint: false,
    // bash allowlist is not an OS sandbox — treat as destructive.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  implement: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  judge: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  manual: {
    readOnlyHint: false,
    // May run verify/implement when policy allows.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  smoke: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  getRun: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  cancelRun: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  batch: {
    readOnlyHint: false,
    // Aggregate tool may include implement/apply.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  roles: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;
