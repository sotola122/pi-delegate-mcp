import { DelegateError } from "../core/errors.js";

/**
 * Await `promise`, rejecting with cancelled DelegateError if `signal` aborts
 * before the promise settles.
 */
export async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new DelegateError("cancelled", "cancelled", true);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DelegateError("cancelled", "cancelled", true));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
