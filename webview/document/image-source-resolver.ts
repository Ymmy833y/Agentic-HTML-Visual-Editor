import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from './internal-attribute';

/** The namespace that distinguishes the internal marker from an author-provided regular attribute. */
export const RENDERING_SOURCE_ATTRIBUTE_NAMESPACE = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}rendering`;

/**
 * The name of the attribute that preserves an author-provided image source rewritten for rendering.
 *
 * Saved HTML must retain the relative path, so the resolved URI does not overwrite the author's
 * value. The tree stores it as a marker used only for rendering. During serialization, the
 * namespaced attribute is removed and its value is restored to `src`.
 */
export const RENDERING_SOURCE_ATTRIBUTE_NAME = 'data-ahve-source';

/**
 * Determines the URI that should replace one `src` value.
 *
 * @param value The `src` value.
 * @param documentUri The document URI used as the base for resolving relative paths. May be empty.
 * @param resourceRootUri The resource root URI. May be empty.
 * @returns The resolved URI only when it is within the permitted scope; otherwise `undefined`.
 */
export function resolveImageSource(
  value: string,
  documentUri: string,
  resourceRootUri: string,
): string | undefined {
  if (documentUri === '' || resourceRootUri === '') {
    return undefined;
  }

  try {
    // A value parsed without a base is an absolute URL with a scheme. The view can render both
    // `http` and `data` URLs as-is, so leave them unchanged.
    new URL(value);
    return undefined;
  } catch {
    // This is a relative path. Resolve it against the base below.
  }

  let resolved: URL;
  let root: URL;
  try {
    resolved = new URL(value, documentUri);
    root = new URL(resourceRootUri);
  } catch {
    return undefined;
  }

  const rootPrefix = root.href.endsWith('/') ? root.href : `${root.href}/`;

  return resolved.href.startsWith(rootPrefix) ? resolved.href : undefined;
}

/**
 * Replaces `src` only for `img` elements in the tree that resolve within the permitted scope.
 *
 * `srcset` is not handled. The internal marker is namespaced, preserving a regular attribute with
 * the same spelling.
 *
 * @param root The fragment before it is inserted into the document.
 * @param documentUri The document URI used as the base for resolving relative paths. May be empty.
 * @param resourceRootUri The resource root URI. May be empty.
 */
export function resolveImageSources(
  root: DocumentFragment,
  documentUri: string,
  resourceRootUri: string,
): void {
  for (const image of root.querySelectorAll('img')) {
    image.removeAttributeNS(
      RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
      RENDERING_SOURCE_ATTRIBUTE_NAME,
    );

    const source = image.getAttribute('src');
    if (source === null) {
      continue;
    }

    const resolved = resolveImageSource(source, documentUri, resourceRootUri);
    if (resolved === undefined) {
      continue;
    }

    image.setAttributeNS(
      RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
      RENDERING_SOURCE_ATTRIBUTE_NAME,
      source,
    );
    image.setAttribute('src', resolved);
  }
}

/**
 * Restores the `src` of images rewritten for rendering back to the value the
 * author wrote.
 *
 * @param root The copy for serialization whose image `src` values are restored.
 */
export function restoreImageSources(root: ParentNode): void {
  const images = root instanceof HTMLImageElement
    ? [root]
    : [...root.querySelectorAll('img')];

  for (const image of images) {
    const source = image.getAttributeNS(
      RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
      RENDERING_SOURCE_ATTRIBUTE_NAME,
    );
    if (source === null) {
      continue;
    }

    image.setAttribute('src', source);
    image.removeAttributeNS(
      RENDERING_SOURCE_ATTRIBUTE_NAMESPACE,
      RENDERING_SOURCE_ATTRIBUTE_NAME,
    );
  }
}
