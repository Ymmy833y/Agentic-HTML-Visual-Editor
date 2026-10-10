import { trimHref } from '../../common/index';
import type { PdfPageLink } from '../../common/index';
import type { InternalErrorSink } from '../diagnostics/error-reporter';
import { readHrefSuffix, toPathSegments } from '../link/link-path';
import { LINK_OPEN_FAILURE, formatLinkOpenFailure, resolveLinkTarget } from '../link/relative-link-opener';
import type { LinkOpenFailure, LinkResolveHost } from '../link/relative-link-opener';
import type { JpegPage, PdfLinkAnnotation } from './pdf-writer';

// Schemes a link in the PDF may open. A PDF reader hands the URL to the system as it is, so only the web and mail are
// opened; other schemes, such as javascript, data or file, could start something the document cannot show.
const OPENED_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u;

// The first segment of a Windows path, such as `c:`. VS Code keeps the case of the drive letter as it got it, so the
// document and the chosen save location can spell the same drive differently.
const DRIVE_SEGMENT_PATTERN = /^[A-Za-z]:$/u;

// Reasons a file goes unlinked because something went wrong rather than because of the document. The link still only
// goes unlinked, but the cause is kept for maintainers, since nothing else would show why the link is missing.
const RECORDED_FAILURES: ReadonlySet<LinkOpenFailure> = new Set([
  LINK_OPEN_FAILURE.openFailed,
  LINK_OPEN_FAILURE.unexpectedError,
]);

/** A page image the view drew, decoded, with its links as the view sent them. */
export interface DrawnPage {
  /** The bytes of the JPEG file. */
  readonly jpeg: Uint8Array;
  /** Width of the image in pixels. */
  readonly width: number;
  /** Height of the image in pixels. */
  readonly height: number;
  /** The links on the page, in the pixels of the image. */
  readonly links: readonly PdfPageLink[];
}

/** Where an href leads, decided before the save location is known. */
export type PdfHrefTarget =
  /** A URL opened as written. */
  | { readonly kind: 'uri'; readonly uri: string }
  /** A file the editor would open, and the query and fragment of the href as written. */
  | { readonly kind: 'file'; readonly targetPath: string; readonly suffix: string };

/** The parts of a URI that decide whether one location can name another by a relative path. */
export interface LinkLocation {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
}

/**
 * Decides where each distinct href of the pages leads.
 *
 * A link that wraps over lines gives one rectangle per line, all with the same href, so each href is resolved once.
 * A file is looked up with the rules the editor follows when a link is opened, so the PDF links exactly the files the
 * editor would open. An href that leads nowhere is left out of the map.
 *
 * @param pages The drawn pages.
 * @param host Ports bound to the document, for resolving and checking files.
 * @param errorSink Where a file that could not be checked, or a port that threw, is recorded.
 * @returns The target of each href that leads somewhere.
 */
export async function resolvePdfLinkTargets(
  pages: readonly Pick<DrawnPage, 'links'>[],
  host: LinkResolveHost,
  errorSink: InternalErrorSink,
): Promise<ReadonlyMap<string, PdfHrefTarget>> {
  const hrefs = new Set<string>();
  for (const page of pages) {
    for (const link of page.links) {
      if (link.target.kind === 'href') {
        hrefs.add(link.target.href);
      }
    }
  }
  const targets = new Map<string, PdfHrefTarget>();
  for (const href of hrefs) {
    const target = await resolveHrefTarget(href, host, errorSink);
    if (target !== undefined) {
      targets.set(href, target);
    }
  }
  return targets;
}

/**
 * Decides where one href leads.
 *
 * @param href The href as the view sent it.
 * @param host Ports bound to the document.
 * @param errorSink Where a file that could not be checked, or a port that threw, is recorded.
 * @returns The target, or `undefined` for an href the PDF does not open.
 */
async function resolveHrefTarget(
  href: string,
  host: LinkResolveHost,
  errorSink: InternalErrorSink,
): Promise<PdfHrefTarget | undefined> {
  const written = trimHref(href);
  const scheme = SCHEME_PATTERN.exec(written)?.[1];
  if (scheme !== undefined) {
    return OPENED_SCHEMES.has(scheme.toLowerCase()) ? { kind: 'uri', uri: written } : undefined;
  }
  const resolution = await resolveLinkTarget(written, host);
  if (resolution.resolved) {
    return { kind: 'file', targetPath: resolution.targetPath, suffix: readHrefSuffix(written) };
  }
  // A file that cannot be opened is a state of the document, not a failure of the export, so it only goes unlinked
  // and nothing is shown to the user.
  if (RECORDED_FAILURES.has(resolution.failure)) {
    errorSink.reportInternalError(
      `Left a link out of the PDF: ${formatLinkOpenFailure(resolution.failure, written, resolution.cause)}`,
    );
  }
  return undefined;
}

/**
 * Writes the path from the folder of the saved PDF to a file, as a relative URL.
 *
 * A PDF reader resolves a relative link against the PDF itself, so the path starts where the PDF is saved, wherever
 * that is. It always starts with `./` or `../`: Chrome takes a first segment with two or more dots, such as `a.b.html`,
 * for a host name. Each segment is percent-encoded, so a `?`, `#` or `%` in a file name stays part of the name.
 *
 * @param pdf Where the PDF is saved.
 * @param documentUri The document, whose file system the target is on.
 * @param targetPath The path of the target file, decoded.
 * @param suffix The query and fragment of the href as written, appended as is.
 * @returns The relative URL, or `undefined` when no relative path leads from the PDF to the file: another scheme,
 *   another authority or another drive.
 */
export function toRelativeLinkReference(
  pdf: LinkLocation,
  documentUri: Omit<LinkLocation, 'path'>,
  targetPath: string,
  suffix: string,
): string | undefined {
  if (pdf.scheme !== documentUri.scheme || pdf.authority !== documentUri.authority) {
    return undefined;
  }
  // The reader climbs the URL of the PDF, whose path VS Code separates with `/` on every platform, so a `\` in a folder
  // name stays part of that name here. The target was resolved by the editor's rules, which take `\` for a separator.
  const folder = pdf.path.split('/').filter((segment) => segment !== '' && segment !== '.');
  folder.pop();
  const target = toPathSegments(targetPath);
  if (!isSameDrive(folder[0], target[0])) {
    return undefined;
  }

  let common = 0;
  while (
    common < folder.length
    && common < target.length
    && (folder[common] === target[common] || (common === 0 && isDriveSegment(folder[0])))
  ) {
    common += 1;
  }
  // The target is a file, so it is never the folder of the PDF or one above it.
  if (common === target.length) {
    return undefined;
  }
  const up = folder.length - common;
  const prefix = up === 0 ? './' : '../'.repeat(up);
  return `${prefix}${target.slice(common).map((segment) => encodeURIComponent(segment)).join('/')}${suffix}`;
}

/**
 * Turns the links the view sent into the link annotations of the PDF saved at a location.
 *
 * A link with no target, or a file no relative path reaches, is dropped; the page image still shows its text.
 *
 * @param pages The drawn pages.
 * @param targets The target of each href that leads somewhere.
 * @param pdf Where the PDF is saved.
 * @param documentUri The document.
 * @returns The pages ready to be written.
 */
export function attachLinkTargets(
  pages: readonly DrawnPage[],
  targets: ReadonlyMap<string, PdfHrefTarget>,
  pdf: LinkLocation,
  documentUri: Omit<LinkLocation, 'path'>,
): JpegPage[] {
  return pages.map((page) => ({
    jpeg: page.jpeg,
    width: page.width,
    height: page.height,
    links: page.links.flatMap((link): PdfLinkAnnotation[] => {
      const { x, y, width, height } = link;
      if (link.target.kind === 'page') {
        return [{ x, y, width, height, target: link.target }];
      }
      const target = targets.get(link.target.href);
      if (target === undefined) {
        return [];
      }
      if (target.kind === 'uri') {
        return [{ x, y, width, height, target }];
      }
      const uri = toRelativeLinkReference(pdf, documentUri, target.targetPath, target.suffix);
      return uri === undefined ? [] : [{ x, y, width, height, target: { kind: 'uri', uri } }];
    }),
  }));
}

/**
 * Returns whether two first segments are on the same drive, or neither names a drive.
 *
 * @param left The first segment of one path.
 * @param right The first segment of the other path.
 */
function isSameDrive(left: string | undefined, right: string | undefined): boolean {
  const leftDrive = isDriveSegment(left);
  const rightDrive = isDriveSegment(right);
  if (!leftDrive && !rightDrive) {
    return true;
  }
  return leftDrive && rightDrive && left?.toLowerCase() === right?.toLowerCase();
}

/**
 * Returns whether a segment names a Windows drive.
 *
 * @param segment The segment.
 */
function isDriveSegment(segment: string | undefined): boolean {
  return segment !== undefined && DRIVE_SEGMENT_PATTERN.test(segment);
}
