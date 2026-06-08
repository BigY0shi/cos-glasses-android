/** Safely extract error message from unknown catch value */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
