/** API errors carry a stable code; the web app translates `err.<code>`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
export const badRequest = (code = 'badRequest', details?: unknown) => new ApiError(400, code, details);
export const unauthorized = (code = 'unauthorized') => new ApiError(401, code);
export const forbidden = (code = 'forbidden') => new ApiError(403, code);
export const notFound = (code = 'notFound') => new ApiError(404, code);
export const conflict = (code: string) => new ApiError(409, code);
