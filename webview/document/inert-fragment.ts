/**
 * Parses body text into a tree detached from the live document.
 *
 * The text is parsed as `<template>` content for two reasons. First, the content belongs to a
 * document separate from the live document, so scripts cannot run and img or link elements cannot
 * fetch external resources before validation finishes. Second, meta, link, style, and base elements
 * inside a `<template>` are not moved into the head, so elements from the body remain in the body.
 * Parsing a complete document would move them into the head and exclude them from body validation.
 *
 * @param bodyText Body text from inside `<body>`. May be empty.
 * @param document Document used to create the tree.
 * @returns The parsed tree. The browser's error recovery handles missing closing tags, so this
 * function does not throw.
 */
export function parseInertFragment(bodyText: string, document: Document): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = bodyText;
  return template.content;
}
