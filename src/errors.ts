/** An error whose message is safe to show to API callers. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "invalid_request", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do this.") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Resource") {
    super(404, "not_found", `${what} not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "conflict", message);
  }
}

/**
 * Raised when a record is written into a tenant partition it does not belong to.
 * This is a programming error, not a user error, so the API reports it as a generic failure.
 */
export class TenantMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`record belongs to tenant ${actual}, not ${expected}`);
    this.name = "TenantMismatchError";
  }
}

/** A job handler throws this when retrying cannot help (for example, an empty document). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
