import { describe, expect, it } from 'vitest';

import { readRootLanguage } from '../../webview/document/document-language';

describe('reading a language declaration from the prologue', () => {
  it('reads the html lang attribute', () => {
    expect(readRootLanguage('<!DOCTYPE html>\n<html lang="en">\n<head></head>\n<body>')).toBe('en');
  });

  it('returns undefined when html has no lang attribute', () => {
    expect(readRootLanguage('<html>\n<body>')).toBeUndefined();
  });

  it('returns undefined for an empty lang attribute', () => {
    expect(readRootLanguage('<html lang="">\n<body>')).toBeUndefined();
  });
});
