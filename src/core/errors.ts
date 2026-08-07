export class DelegateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly infrastructure = false,
  ) {
    super(message);
    this.name = "DelegateError";
  }
}

export function isInfrastructureError(err: unknown): boolean {
  return err instanceof DelegateError && err.infrastructure;
}
