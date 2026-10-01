import { restoreQuarantinedAttributes } from './attribute-sanitizer';
import { restoreImageSources } from './image-source-resolver';
import { removeInternalAttributes } from './internal-attribute';

/** An inverse-transformed copy and maps between it and the live tree in both directions. */
export interface MappedCopy {
  /** The inverse-transformed copy. */
  readonly copy: DocumentFragment;
  /** A map from nodes in the live tree to nodes in the copy. */
  readonly liveToCopy: ReadonlyMap<Node, Node>;
  /** A map from nodes in the copy to nodes in the live tree. */
  readonly copyToLive: ReadonlyMap<Node, Node>;
}

/**
 * Registers corresponding nodes from the live tree and copy in both maps.
 *
 * @param live The node in the live tree.
 * @param copy The corresponding node in the copy.
 * @param liveToCopy The map from the live tree to the copy.
 * @param copyToLive The map from the copy to the live tree.
 */
function linkNodes(
  live: Node,
  copy: Node,
  liveToCopy: Map<Node, Node>,
  copyToLive: Map<Node, Node>,
): void {
  liveToCopy.set(live, copy);
  copyToLive.set(copy, live);

  const liveChildren = live.childNodes;
  const copyChildren = copy.childNodes;
  for (let index = 0; index < liveChildren.length; index += 1) {
    const copyChild = copyChildren[index];
    if (copyChild === undefined) {
      return;
    }
    linkNodes(liveChildren[index], copyChild, liveToCopy, copyToLive);
  }
}

/**
 * Builds an inverse-transformed copy on an inert document without modifying the live tree, while
 * also creating one-to-one mappings between nodes in the live tree and copy.
 *
 * The maps are created immediately after copying, before either the inverse transform or editing-artifact
 * removal. At that point both structures match exactly, so boundaries within text and between an
 * element's children can both be mapped. The inverse transform changes only attributes, so these
 * mappings remain valid afterward.
 *
 * @param root The tree to copy and inverse-transform.
 * @returns The inverse-transformed copy and maps in both directions.
 */
export function createMappedCopy(root: Element | DocumentFragment): MappedCopy {
  const inertDocument = root.ownerDocument.implementation.createHTMLDocument('');
  const copy = inertDocument.createDocumentFragment();
  const liveToCopy = new Map<Node, Node>();
  const copyToLive = new Map<Node, Node>();

  // Map the roots as well; this is required for boundaries whose container is the editor root itself.
  liveToCopy.set(root, copy);
  copyToLive.set(copy, root);

  for (const child of [...root.childNodes]) {
    const imported = inertDocument.importNode(child, true);
    copy.append(imported);
    linkNodes(child, imported, liveToCopy, copyToLive);
  }

  restoreQuarantinedAttributes(copy);
  restoreImageSources(copy);
  removeInternalAttributes(copy);
  return { copy, liveToCopy, copyToLive };
}

/**
 * Builds an inverse-transformed copy on an inert document, without modifying the live tree.
 *
 * @param root The tree to copy and inverse-transform.
 * @returns The inverse-transformed copy, belonging to an inert document.
 */
export function createInverseTransformedCopy(root: Element | DocumentFragment): DocumentFragment {
  return createMappedCopy(root).copy;
}
