/**
 * Container-uniform truncation-driven fold.
 *
 * Pixel-based container queries cannot fold "just as the name starts to
 * truncate" because name length varies per circuit ("Spa" vs
 * "Commissioned PV System"). Per-row decisions, however, leave the
 * grid uneven: short-name rows stay one-line while long-name rows
 * fold to two, scattering row heights across the view.
 *
 * Solution: measure each row's name, but apply the fold uniformly to
 * every row in the container. The decision is a single boolean — "does
 * the longest name fit?" — and every row gets the same layout. The
 * grid stays visually even regardless of per-circuit name length.
 *
 * Hysteresis: once folded we record the row width that triggered it.
 * The unfold side waits until rows grow past
 * ``foldedAtWidth + hysteresisPx`` before lifting the class. Without
 * this the layout would flip back as soon as it folded (folded layout
 * gives the name a full row → no truncation → unfold check fires →
 * back to one-line → truncation again → fold → loop).
 */

export interface FoldConfig {
  /** CSS selector for the row element that gets the fold class. */
  rowSelector: string;
  /** CSS selector (relative to row) for the name element measured. */
  nameSelector: string;
  /** Class to toggle on the row when folded. */
  foldClass: string;
  /** Extra px the row must grow past the fold-trigger width before
   * unfolding. Defaults to 48px — large enough to avoid oscillation
   * for borderline-fitting names, where the unfolded layout consumes
   * additional width on the chrome (badges, controls) that a folded
   * row's measurement does not reflect. */
  hysteresisPx?: number;
}

/**
 * Watch every row inside ``container`` and toggle the fold class
 * uniformly across all rows when any one of them would have its name
 * truncated. Returns an ``unobserve`` function that tears down the
 * ResizeObserver + MutationObserver — call it before the next render
 * to avoid leaking observers across re-renders.
 *
 * One ResizeObserver instance is shared across rows; a MutationObserver
 * on the container picks up rows added later (filter changes,
 * expand/collapse, search).
 */
export function observeFold(container: HTMLElement, config: FoldConfig): () => void {
  const hysteresis = config.hysteresisPx ?? 48;
  const observed = new WeakSet<HTMLElement>();
  /**
   * Width of a representative row when the fold was triggered. While
   * folded we wait for that width to grow past the hysteresis margin
   * before unfolding. ``null`` means currently unfolded.
   */
  let foldedAtWidth: number | null = null;

  /**
   * True when ``row``'s name is currently truncated under the
   * unfolded layout. Two signals:
   *   - ``scrollWidth > clientWidth`` is the textbook ellipsis check
   *     and works whenever the name has any positive width.
   *   - ``clientWidth < 1`` covers the case where other flex children
   *     have squeezed the name's flex slot down to zero. By definition
   *     the name is then invisible and counts as truncated; ``scroll
   *     Width`` may also be 0 in that state which would make the first
   *     check miss.
   */
  const isRowTruncated = (row: HTMLElement): boolean => {
    const name = row.querySelector<HTMLElement>(config.nameSelector);
    if (!name) return false;
    if (row.clientWidth === 0) return false;
    if (name.clientWidth < 1) return true;
    return name.scrollWidth > name.clientWidth + 1;
  };

  /**
   * Re-evaluate the container's fold state from the live row
   * measurements. Called whenever any row resizes (ResizeObserver) or
   * the row set changes (MutationObserver after a filter / sort /
   * expand).
   */
  const evaluate = (): void => {
    const rows = container.querySelectorAll<HTMLElement>(config.rowSelector);
    if (rows.length === 0) return;
    // Use the first row as the size reference. Rows in the same
    // container share width (single-column = full-width, grid = 1fr
    // tracks of equal width), so any one is representative.
    const refWidth = rows[0]!.clientWidth;
    if (refWidth === 0) return;

    if (foldedAtWidth !== null) {
      // Currently folded — only unfold once rows grow past the trigger
      // width plus hysteresis. While folded the names have their own
      // row each so per-row truncation checks are uninformative; the
      // width comparison is the only reliable "wide enough now" signal.
      if (refWidth > foldedAtWidth + hysteresis) {
        for (const row of rows) row.classList.remove(config.foldClass);
        foldedAtWidth = null;
      }
      return;
    }

    // Currently unfolded — fold every row as soon as any one of them
    // would truncate. Uniform fold keeps the grid visually even
    // instead of scattering row heights based on per-circuit name
    // length.
    let anyTruncated = false;
    for (const row of rows) {
      if (isRowTruncated(row)) {
        anyTruncated = true;
        break;
      }
    }
    if (anyTruncated) {
      for (const row of rows) row.classList.add(config.foldClass);
      foldedAtWidth = refWidth;
    }
  };

  const ro = new ResizeObserver(() => evaluate());

  const attachAll = (): void => {
    const rows = container.querySelectorAll<HTMLElement>(config.rowSelector);
    let added = false;
    for (const row of rows) {
      if (observed.has(row)) continue;
      observed.add(row);
      ro.observe(row);
      added = true;
    }
    if (added) {
      // Layout may not have happened yet — innerHTML insertion +
      // observer attachment can both run before the browser computes
      // sizes, so a synchronous evaluate would see zero widths and
      // do nothing. Defer one rAF to land after layout.
      requestAnimationFrame(() => evaluate());
    }
  };

  attachAll();

  // Watch the subtree because rows can be added under a wrapper that
  // persists across renders (e.g. an incremental row append into an
  // existing .list-view rather than a full container.innerHTML reset).
  // Today's render paths happen to mutate the container's direct child
  // — but tying observer correctness to that invariant is fragile; any
  // future incremental-row code would silently regress the fold.
  // Filter mutations so row-internal churn (expand/collapse, chart
  // remounts) doesn't trigger a needless attachAll pass.
  const mutationTouchesRows = (mutations: MutationRecord[]): boolean => {
    const touchesRows = (nodes: NodeList): boolean => {
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(config.rowSelector)) return true;
        if (node.querySelector(config.rowSelector)) return true;
      }
      return false;
    };
    for (const m of mutations) {
      if (touchesRows(m.addedNodes) || touchesRows(m.removedNodes)) return true;
    }
    return false;
  };

  const mo = new MutationObserver(mutations => {
    if (mutationTouchesRows(mutations)) attachAll();
  });
  mo.observe(container, { childList: true, subtree: true });

  return (): void => {
    ro.disconnect();
    mo.disconnect();
  };
}
