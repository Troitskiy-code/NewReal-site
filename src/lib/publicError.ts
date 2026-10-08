/** Only application validation errors may provide text to a client. */
export class ClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientInputError";
  }
}

export function publicError(error: unknown, fallback: string): { message: string; status: 400 | 500 } {
  return error instanceof ClientInputError
    ? { message: error.message, status: 400 }
    : { message: fallback, status: 500 };
}
