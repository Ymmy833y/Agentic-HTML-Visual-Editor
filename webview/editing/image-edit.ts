import { trimHref } from '../../common/index';
import { QUARANTINED_ATTRIBUTE_NAME, quarantinedNamespace } from '../document/attribute-sanitizer';
import {
  RENDERING_SOURCE_ATTRIBUTE_NAME,
  RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
  resolveImageSource,
} from '../document/image-source-resolver';
import type { BlockRewriteProgress } from './block-format';
import { findVisibleContent, removeCommentAnnotations } from './copy-html';
import type { ImageInsertPorts, ImageValues } from './image-insert';
import { isFormattingExcluded } from './inline-format';
import { cloneRangeFragment } from './range-fragment';

/**
 * The edit kind of an image update.
 *
 * History groups only typing and deletes, so this is spelled differently from both, and from the insertion, to
 * keep it from being grouped with the input before and after it.
 */
export const IMAGE_UPDATE_EDIT_KIND = 'image:update';

/**
 * The ports of the image update: those of the image insertion without the range delete.
 *
 * The ports hold no values and are read on every call, and the base URIs are the values of the mount target.
 */
export type ImageUpdatePorts = Omit<ImageInsertPorts, 'deleteRange'>;

// The size fields. Each name is also the style property and the attribute the size is read from and written to.
const SIZE_PROPERTIES = ['width', 'height'] as const;

type SizeProperty = (typeof SIZE_PROPERTIES)[number];

// A whole number of px, the only size the dialog takes. The digits are captured.
const PIXEL_SIZE_PATTERN = /^([0-9]+)px$/u;

/**
 * Reads the current values of an existing image in the form the image dialog shows them.
 *
 * The source is the value the author wrote, which is the rendering source attribute when the image was resolved
 * for rendering. A quarantined `src` is not shown. A size is read from `style` first and from the attribute of the
 * same name otherwise, the same precedence as the rendering. A whole number of px is shown as its digits and any
 * other size as written, so that the validation asks for it to be fixed instead of it being lost.
 *
 * @param image The image.
 * @returns The current values with surrounding whitespace removed, trimmed the same way as the image values.
 */
export function readCurrentImageValues(image: Element): ImageValues {
  const source = image.getAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME)
    ?? image.getAttribute('src')
    ?? '';
  return {
    source: trimHref(source),
    alt: (image.getAttribute('alt') ?? '').trim(),
    width: readSize(image, 'width'),
    height: readSize(image, 'height'),
  };
}

/**
 * Returns the image a range selects on its own.
 *
 * The range selects the image alone when its visible content, judged the same way as a copy, is that image and
 * nothing else. Whitespace, `br`, comment entries and the empty blocks at the edges that the selection does not
 * visibly cover do not count, so a range dragged up to the image from the end of the previous paragraph still selects
 * it alone.
 *
 * @param range The selection range.
 * @returns The image in the live tree, or `undefined` when the range holds anything else or nothing.
 */
export function findSelectedImage(range: Range): Element | undefined {
  const container = range.commonAncestorContainer;
  const scope = container instanceof Element ? container : container.parentElement;
  if (range.collapsed || scope === null) {
    return undefined;
  }
  // Cloning the range is only worth it when exactly one image is in it. Most ranges hold text alone.
  const images = [...scope.querySelectorAll('img')].filter((image) => range.intersectsNode(image));
  const image = images.length === 1 ? images[0] : undefined;
  if (image === undefined) {
    return undefined;
  }
  const copied = cloneRangeFragment(range);
  // Entries are not displayed, yet a range across the end of a comment holds them. The copy removes them before
  // counting visible content as well, and the copy of the image stays mapped when its comment is unwrapped.
  removeCommentAnnotations(copied.fragment);
  const copy = copied.liveToCopy.get(image);
  if (copy === undefined
    || findVisibleContent(copied.fragment, 'first') !== copy
    || findVisibleContent(copied.fragment, 'last') !== copy) {
    return undefined;
  }
  return image;
}

/**
 * Rewrites an existing image as one standalone edit, writing only the fields changed from its current values.
 *
 * Only what was edited should reach the file, so a field left as it was keeps its attributes and their spelling. An
 * empty alt, for one, declares a decorative image and cannot be told apart from no alt in the dialog. The selection
 * is left as the dialog returned it.
 *
 * @param ports The ports of the image update.
 * @param image The image to rewrite.
 * @param values Image values that passed validation.
 * @param current The current values the dialog opened with.
 * @returns Whether the tree was changed.
 */
export function updateImage(
  ports: ImageUpdatePorts,
  image: Element,
  values: ImageValues,
  current: ImageValues,
): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  // The inside of pre holds code text, and comment bodies and replies are comment entries, so an image there is not
  // rewritten from the dialog, the same as no image is inserted there.
  if (!root.contains(image) || isFormattingExcluded(image, root)) {
    return false;
  }
  if (values.source === current.source
    && values.alt === current.alt
    && values.width === current.width
    && values.height === current.height) {
    return false;
  }
  return ports.runCommandEdit(IMAGE_UPDATE_EDIT_KIND, () => rewriteImage(ports, image, values, current));
}

/**
 * Inside the attempt, writes the changed fields to the image.
 *
 * It returns whether it changed the tree instead of letting exceptions out, so that whatever was changed before a
 * failure is still closed as an edit. Aborting would make the display and the saved content disagree.
 *
 * @param ports The ports of the image update.
 * @param image The image to rewrite.
 * @param values Image values that passed validation.
 * @param current The current values the dialog opened with.
 * @returns Whether the tree was changed.
 */
function rewriteImage(ports: ImageUpdatePorts, image: Element, values: ImageValues, current: ImageValues): boolean {
  const progress: BlockRewriteProgress = { changed: false };
  try {
    // Record the change before each write, so the change can be closed even if an exception is thrown partway.
    if (values.source !== current.source) {
      progress.changed = true;
      writeSource(image, values.source, ports.documentUri, ports.resourceRootUri);
    }
    if (values.alt !== current.alt) {
      progress.changed = true;
      writeAlt(image, values.alt);
    }
    for (const property of SIZE_PROPERTIES) {
      if (values[property] !== current[property]) {
        progress.changed = true;
        writeSize(image, property, values[property]);
      }
    }
  } catch (error) {
    ports.reportDiagnostic(`Could not update the image: ${String(error)}`);
  }
  return progress.changed;
}

/**
 * Writes a new source to the image, resolved for rendering the same way as the mount.
 *
 * @param image The image.
 * @param source The source that passed validation.
 * @param documentUri The document URI that relative paths are resolved against. Nothing is resolved if empty.
 * @param resourceRootUri The resource root URI. Nothing is resolved if empty.
 */
function writeSource(image: Element, source: string, documentUri: string, resourceRootUri: string): void {
  // A quarantined src goes back to its own name on save, where it would compete with the new value.
  image.removeAttributeNS(quarantinedNamespace('src'), QUARANTINED_ATTRIBUTE_NAME);
  // Decided before src is set. Setting a relative path that resolves on the live image first would start a fetch of
  // the unresolved value.
  const resolved = resolveImageSource(source, documentUri, resourceRootUri);
  if (resolved === undefined) {
    image.removeAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME);
    image.setAttribute('src', source);
    return;
  }
  // The saved src is written back from this attribute, so it keeps the value that was entered.
  image.setAttributeNS(RENDERING_SOURCE_ATTRIBUTE_NAMESPACE, RENDERING_SOURCE_ATTRIBUTE_NAME, source);
  image.setAttribute('src', resolved);
}

/**
 * Writes a new alt text to the image.
 *
 * @param image The image.
 * @param alt The alt text. An empty value removes the attribute.
 */
function writeAlt(image: Element, alt: string): void {
  // An empty alt declares the image decorative. An emptied field does not say that, so no alt is left, the same as
  // an insertion without alt text.
  if (alt === '') {
    image.removeAttribute('alt');
    return;
  }
  image.setAttribute('alt', alt);
}

/**
 * Writes a new width or height to the image's `style`.
 *
 * @param image The image.
 * @param property The size to write.
 * @param value A whole number of px as digits. An empty value removes the size.
 */
function writeSize(image: Element, property: SizeProperty, value: string): void {
  if (image instanceof HTMLElement) {
    if (value === '') {
      image.style.removeProperty(property);
    } else {
      image.style.setProperty(property, `${value}px`);
    }
    // A style left without declarations is removed, the same as an insertion without a size.
    if (image.style.length === 0) {
      image.removeAttribute('style');
    }
  }
  // The attribute of the same name would give the size a second time, and would keep a cleared size in effect.
  image.removeAttribute(property);
}

/**
 * Reads the width or height of an image in the form the image dialog shows it.
 *
 * @param image The image.
 * @param property The size to read.
 * @returns The digits of a whole number of px, any other size as written, or an empty string when there is none.
 */
function readSize(image: Element, property: SizeProperty): string {
  const styled = image instanceof HTMLElement ? image.style.getPropertyValue(property).trim() : '';
  const value = styled === '' ? (image.getAttribute(property) ?? '').trim() : styled;
  return PIXEL_SIZE_PATTERN.exec(value)?.[1] ?? value;
}
