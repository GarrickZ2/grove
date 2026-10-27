// Buttons are 36px wide with 4px gaps, including the overflow trigger.
export function fitIslandPages<T extends { id: string }>(pages: T[], width: number, activeId: string) {
  const capacity = Math.max(0, Math.floor((width + 4) / 40));
  const count = pages.length <= capacity ? pages.length : Math.max(0, capacity - 1);
  const visibleIds = new Set(pages.slice(0, count).map((page) => page.id));
  if (count > 0 && pages.some((page) => page.id === activeId) && !visibleIds.has(activeId)) {
    visibleIds.delete(pages[count - 1].id);
    visibleIds.add(activeId);
  }
  return {
    visible: pages.filter((page) => visibleIds.has(page.id)),
    overflow: pages.filter((page) => !visibleIds.has(page.id)),
  };
}
