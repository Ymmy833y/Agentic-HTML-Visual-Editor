import {
  DANGEROUS_URL_SCHEMES,
  EVENT_HANDLER_ATTRIBUTE_PREFIX,
  SRCSET_ATTRIBUTE_NAME,
  URL_ATTRIBUTE_NAMES,
} from '../../common/index';
import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from './internal-attribute';

const QUARANTINED_NAMESPACE_PREFIX = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}quarantine:`;

/** The local name shared by every quarantined attribute. */
export const QUARANTINED_ATTRIBUTE_NAME = 'data-ahve-quarantined';

/**
 * Returns the quarantine namespace that carries the original attribute name.
 *
 * @param attributeName The original attribute name.
 * @returns The quarantine namespace containing the lowercased attribute name.
 */
export function quarantinedNamespace(attributeName: string): string {
  return `${QUARANTINED_NAMESPACE_PREFIX}${attributeName.toLowerCase()}`;
}

/**
 * Determines whether a URL value begins with a dangerous scheme.
 *
 * Browsers ignore TAB, LF, and CR characters within URL values, as well as leading and trailing
 * control characters and spaces. Applying the same normalization first prevents values such as
 * `java&#9;script:` or values with leading spaces from bypassing the check and being executed.
 *
 * For data URLs, browsers also trim spaces around the MIME type following `data:`. Consequently,
 * `data: text/html,…` is treated as text/html. Applying the same normalization here ensures the
 * prefix comparison matches it.
 *
 * @param value Attribute value representing a URL. May be empty.
 * @returns `true` when the value begins with a dangerous scheme. Relative paths, `http(s)`, and
 * `data:image/*` return `false`.
 */
export function hasDangerousScheme(value: string): boolean {
  const normalized = value
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000-\u0020]+/, '')
    .replace(/[\u0000-\u0020]+$/, '')
    .toLowerCase()
    // Only spaces and form feeds can remain as ASCII whitespace before the MIME type because TAB,
    // LF, and CR characters were removed from the entire value above.
    .replace(/^data:[ \f]+/, 'data:');

  return DANGEROUS_URL_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/**
 * Determines whether an attribute has to be quarantined.
 *
 * A quarantined attribute is renamed into an internal namespace while keeping its
 * value. Matching this check never discards the value.
 *
 * @param name The attribute name read from the tree.
 * @param value The attribute value, with character references already resolved by
 * parsing.
 * @returns `true` when the attribute has to be quarantined.
 */
export function isUnsafeAttribute(name: string, value: string): boolean {
  const attributeName = name.toLowerCase();

  // Checking the prefix catches unlisted handler names such as `onfoo`, while excluding names such
  // as `data-onclick`, where `on` is not the prefix.
  if (attributeName.startsWith(EVENT_HANDLER_ATTRIBUTE_PREFIX)) {
    return true;
  }

  if (!URL_ATTRIBUTE_NAMES.has(attributeName)) {
    return false;
  }

  if (attributeName === SRCSET_ATTRIBUTE_NAME) {
    return value.split(',').some((candidate) => hasDangerousScheme(candidate));
  }

  return hasDangerousScheme(value);
}

/**
 * Visits one element and every one of its descendants.
 *
 * `<template>` holds its content in a separate tree rather than in child nodes, so
 * the attributes inside it slip through unless it is visited explicitly.
 *
 * @param element The element to start from.
 * @param visitor The operation to call for each element.
 */
function visitElement(element: Element, visitor: (target: Element) => void): void {
  visitor(element);
  const children = element instanceof HTMLTemplateElement ? element.content.children : element.children;
  for (const child of [...children]) {
    visitElement(child, visitor);
  }
}

/**
 * Visits every element contained in the tree.
 *
 * @param root An element itself, or a container holding elements as children.
 * @param visitor The operation to call for each element.
 */
function visitTree(root: ParentNode, visitor: (target: Element) => void): void {
  if (root instanceof Element) {
    visitElement(root, visitor);
    return;
  }
  for (const child of [...root.children]) {
    visitElement(child, visitor);
  }
}

/**
 * Renames the attributes of one element to their quarantined names, or back to
 * their original names.
 *
 * The order of the attributes shows up in the spelling of the output, and an
 * attribute can only be renamed by putting it back. So for an element that holds a
 * target, every attribute is removed and then set again in the original order. An
 * element that holds no target is left untouched — even just setting the attributes
 * again would leave room for the spelling of an unedited line to move.
 *
 * Attributes that are not targets are re-inserted as the removed `Attr` itself.
 * Recreating them from their names would throw on a name that parsing accepts but
 * `setAttribute` rejects (the `=x` produced by `<p =x onclick="1">`), which would
 * make a document holding such an attribute impossible to mount.
 *
 * @param element The element whose attributes are renamed.
 * @param restore `true` to restore quarantined names to the original names, `false`
 * to move original names to their quarantined names.
 */
function replaceAttributes(element: Element, restore: boolean): void {
  const attributes = [...element.attributes];
  const hasTarget = attributes.some((attribute) => restore
    ? attribute.namespaceURI?.startsWith(QUARANTINED_NAMESPACE_PREFIX) === true
    : isUnsafeAttribute(attribute.name, attribute.value));
  if (!hasTarget) {
    return;
  }

  for (const attribute of attributes) {
    element.removeAttributeNode(attribute);
  }

  for (const attribute of attributes) {
    const namespace = attribute.namespaceURI;
    if (restore && namespace?.startsWith(QUARANTINED_NAMESPACE_PREFIX) === true) {
      element.setAttribute(namespace.slice(QUARANTINED_NAMESPACE_PREFIX.length), attribute.value);
    } else if (!restore && isUnsafeAttribute(attribute.name, attribute.value)) {
      element.setAttributeNS(
        quarantinedNamespace(attribute.name),
        QUARANTINED_ATTRIBUTE_NAME,
        attribute.value,
      );
    } else {
      element.setAttributeNodeNS(attribute);
    }
  }
}

/**
 * Renames dangerous attributes into an internal namespace that carries their
 * original names.
 *
 * @param root The tree whose dangerous attributes are quarantined.
 */
export function quarantineUnsafeAttributes(root: ParentNode): void {
  visitTree(root, (element) => replaceAttributes(element, false));
}

/**
 * Restores quarantined attributes to their original names and values.
 *
 * @param root The copy for serialization whose quarantined attributes are restored.
 */
export function restoreQuarantinedAttributes(root: ParentNode): void {
  visitTree(root, (element) => replaceAttributes(element, true));
}
