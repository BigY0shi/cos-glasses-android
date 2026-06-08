// Display formatting constants for Even G2 glasses
// Screen: 576x288 pixels, monospace font
export const MAX_TEXT_CHARS = 400
export const MAX_LIST_ITEMS = 20
export const MAX_LIST_ITEM_CHARS = 64

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + '...'
}

export function truncateLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // Truncate at a line boundary if possible
  const lines = text.split('\n')
  let result = ''
  for (const line of lines) {
    const next = result ? result + '\n' + line : line
    if (next.length > maxChars - 3) break
    result = next
  }
  return result || text.slice(0, maxChars - 3) + '...'
}
