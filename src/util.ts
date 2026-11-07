/**
 * What the app does with an error a plugin throws, by its code: signIn asks
 * the listener to sign in, setup sends them to the plugin's settings,
 * unavailable and unsupported say so. Without a code it's shown as it is.
 */
export type FailCode = "signIn" | "setup" | "unavailable" | "unsupported";

export interface CodedError extends Error {
  code?: FailCode;
}

export function fail(code: FailCode, message?: string): CodedError {
  const e: CodedError = new Error(message || code);
  e.code = code;
  return e;
}

export const codeOf = (e: unknown): FailCode | undefined => (e as CodedError | null)?.code;

/** The text in the listener's language. */
export const t = (text: string): string => host.t(text);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const isCatalogID = (id: string): boolean => /^\d+$/.test(id);
