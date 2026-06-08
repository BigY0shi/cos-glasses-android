// Local-timezone YYYY-MM-DD helper.
// Replaces `new Date(...).toISOString().slice(0,10)` which is UTC — that
// makes CDT/PST users see their own late-evening sessions archived under
// "tomorrow" from their POV. We key archives and "today" filters off the
// server's local timezone so the user's sense of "today" matches what they see.

export function localDay(ts: number = Date.now()): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
