/* The logger the server modules write to. console satisfies it; tests pass a quiet one. */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const quietLogger: Logger = { info() {}, warn() {}, error: (...a) => console.error(...a) };
