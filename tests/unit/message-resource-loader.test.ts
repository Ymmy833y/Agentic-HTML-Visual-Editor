// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

import { loadMessages } from '../../src/i18n/message-resource-loader';

// Resources treated as placed in the extension's install location, keyed by path.
const resourceFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { path: string }, ...segments: string[]): { path: string } => ({
      path: [base.path, ...segments].join('/'),
    }),
  },
  workspace: {
    fs: {
      // As in the real environment, reading a missing file fails with an error.
      readFile: (uri: { path: string }): Promise<Uint8Array> => {
        const text = resourceFiles.get(uri.path);
        return text === undefined
          ? Promise.reject(new Error(`File not found: ${uri.path}`))
          : Promise.resolve(new TextEncoder().encode(text));
      },
    },
  },
}));

const EXTENSION_URI = { path: '/extension' } as vscode.Uri;

/**
 * Treats a locale's message resource as placed in the extension's install location.
 *
 * @param locale The locale of the resource.
 * @param catalog The message catalog to write to the resource.
 */
function placeResource(locale: string, catalog: Record<string, string>): void {
  resourceFiles.set(`/extension/messages/messages.${locale}.json`, JSON.stringify(catalog));
}

describe('Loading the message resource for the display language', () => {
  beforeEach(() => {
    resourceFiles.clear();
    placeResource('en', { 'toolbar.save': 'Save', 'toolbar.bold': 'Bold' });
  });

  it('prefers a resource matching the region over one matching only the base language', async () => {
    placeResource('pt-br', { 'toolbar.save': 'pt-br save', 'toolbar.bold': 'pt-br bold' });
    placeResource('pt', { 'toolbar.save': 'pt save', 'toolbar.bold': 'pt bold' });

    await expect(loadMessages(EXTENSION_URI, 'pt-br')).resolves.toEqual({
      locale: 'pt-br',
      catalog: { 'toolbar.save': 'pt-br save', 'toolbar.bold': 'pt-br bold' },
    });
  });

  it('falls back to the base-language resource when no region match exists', async () => {
    placeResource('pt', { 'toolbar.save': 'pt save', 'toolbar.bold': 'pt bold' });

    await expect(loadMessages(EXTENSION_URI, 'pt-br')).resolves.toEqual({
      locale: 'pt',
      catalog: { 'toolbar.save': 'pt save', 'toolbar.bold': 'pt bold' },
    });
  });

  it('fills message keys missing from the display language resource with English messages', async () => {
    placeResource('ja', { 'toolbar.save': 'ja save' });

    await expect(loadMessages(EXTENSION_URI, 'ja')).resolves.toEqual({
      locale: 'ja',
      catalog: { 'toolbar.save': 'ja save', 'toolbar.bold': 'Bold' },
    });
  });

  it('falls back to the English resource when the display language has none', async () => {
    placeResource('ja', { 'toolbar.save': 'ja save' });

    await expect(loadMessages(EXTENSION_URI, 'fr')).resolves.toEqual({
      locale: 'en',
      catalog: { 'toolbar.save': 'Save', 'toolbar.bold': 'Bold' },
    });
  });
});
