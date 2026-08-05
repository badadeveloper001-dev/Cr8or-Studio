import { NextResponse } from "next/server";
import { ZodError } from "zod";

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

type ApiErrorOptions = {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
};

export function errorResponse(options: ApiErrorOptions) {
  return NextResponse.json(
    {
      ok: false,
      message: options.message,
      error: {
        code: options.code,
        message: options.message,
        details: options.details,
        requestId: options.requestId,
      },
      ...(options.details ? { issues: options.details } : {}),
    },
    { status: options.status },
  );
}

export function validationErrorResponse(error: ZodError, requestId?: string) {
  return errorResponse({
    status: 400,
    code: "INVALID_REQUEST",
    message: "Invalid request payload.",
    details: error.issues,
    requestId,
  });
}

export function internalErrorResponse(message: string, requestId?: string, details?: unknown) {
  return errorResponse({
    status: 500,
    code: "INTERNAL_ERROR",
    message,
    details,
    requestId,
  });
}
