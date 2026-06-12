// Open/close toggle for <details> inside the contenteditable host.
//
// Clicking a <summary> is overloaded: it should toggle the disclosure, but the
// summary text is also editable. We scope toggling to a narrow marker zone on
// the left of the summary (where the disclosure chevron is drawn) so clicking
// the title text still places a caret for editing.
//
// The browser's native toggle still fires on a summary click even inside a
// contenteditable host, so a plain click on the title text would collapse the
// section while the user is trying to edit it. We therefore cancel the native
// toggle on every summary click and drive open/close exclusively through the
// marker zone, leaving text clicks to place a caret only.

export interface DetailsOptions {
  /** Called after a toggle mutates the open state so the edit can be saved. */
  onChange: () => void;
}

// Width (px) of the clickable disclosure-marker zone, measured from the
// summary's left border. Must roughly match the summary left padding + chevron
// size in default.css.
const MARKER_HIT_PX = 24;

// True when the pointer event landed within the summary's left marker zone.
function inMarkerZone(summary: Element, clientX: number): boolean {
  const rect = summary.getBoundingClientRect();
  return clientX - rect.left < MARKER_HIT_PX;
}

function summaryFromEvent(root: HTMLElement, e: MouseEvent): HTMLElement | null {
  const target = e.target as Element | null;
  if (!target) return null;
  const summary = target.closest('summary');
  if (!summary || !root.contains(summary)) return null;
  return summary;
}

export function mountDetails(root: HTMLElement, opts: DetailsOptions): void {
  // Suppress caret placement when the marker is pressed (caret placement is a
  // mousedown default action). A click on the title text still places a caret.
  root.addEventListener('mousedown', (e: MouseEvent) => {
    const summary = summaryFromEvent(root, e);
    if (summary && inMarkerZone(summary, e.clientX)) e.preventDefault();
  });

  root.addEventListener('click', (e: MouseEvent) => {
    const summary = summaryFromEvent(root, e);
    if (!summary) return;
    const details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS') return;

    // Cancel the browser's native toggle for every summary click; we drive
    // open/close only from the marker zone.
    e.preventDefault();
    if (!inMarkerZone(summary, e.clientX)) return;

    if (details.hasAttribute('open')) {
      details.removeAttribute('open');
    } else {
      details.setAttribute('open', '');
    }
    opts.onChange();
  });
}
