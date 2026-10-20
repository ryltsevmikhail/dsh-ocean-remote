/** Visible, enabled sequential stops, including native disclosure summaries. */
export function dialogTabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]'))
    .filter(item => {
      if (item.tabIndex < 0 || item.matches(':disabled') || item.getClientRects().length === 0) return false
      if (getComputedStyle(item).visibility === 'hidden' || item.checkVisibility?.() === false) return false
      // Chromium can report nonempty rectangles for hidden details content.
      // Keep its first summary (and descendants), never its collapsed body.
      for (let parent = item.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
        if (parent.tagName !== 'DETAILS' || parent.hasAttribute('open')) continue
        const summary = Array.from(parent.children).find(child => child.tagName === 'SUMMARY')
        if (!summary?.contains(item)) return false
      }
      return true
    })
}
