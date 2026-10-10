// The view draws each page at the shape of the area inside the margins and the host places the image there, so both
// sides read the paper from here. A drift between them would stretch or cut the drawn pages.

/** Width of an A4 page in PDF points (1/72 inch). */
export const PAGE_WIDTH_PT = 595.28;

/** Height of an A4 page in PDF points. */
export const PAGE_HEIGHT_PT = 841.89;

/** Margin on every side of the page in PDF points: 15 mm. */
export const PAGE_MARGIN_PT = (15 / 25.4) * 72;

/** Width of the area inside the margins in PDF points. */
export const CONTENT_WIDTH_PT = PAGE_WIDTH_PT - PAGE_MARGIN_PT * 2;

/** Height of the area inside the margins in PDF points. */
export const CONTENT_HEIGHT_PT = PAGE_HEIGHT_PT - PAGE_MARGIN_PT * 2;
