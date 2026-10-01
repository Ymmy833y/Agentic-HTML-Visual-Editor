import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { ImageValues } from '../../webview/editing/image-insert';
import type { ActionDialogResult, ActionDialogSpec } from '../../webview/ui/action-dialog';
import {
  buildImageDialogSpec,
  openImageDialog,
  openImageEditDialog,
  readImageValues,
  validateImageValues,
} from '../../webview/ui/image-dialog';
import type { ImageDialogPorts } from '../../webview/ui/image-dialog';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// A localizer that returns the message key as is. The kind of rejection is told apart by its key.
const LOCALIZER = createLocalizer({});

// The values the dialog stand-in confirms with unless told otherwise.
const CONFIRMED_VALUES = { source: 'a.png', alt: '', width: '', height: '' };

/** Ports to override. Unless given, the result is returned as confirmed and insertions and updates are recorded. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly insertImage?: (values: ImageValues) => boolean;
  readonly updateImage?: (image: Element, values: ImageValues, current: ImageValues) => boolean;
  readonly confirmedValues?: Readonly<Record<string, string>>;
  readonly cancelled?: boolean;
}

/** One call of the update port. */
interface UpdateCall {
  readonly image: Element;
  readonly values: ImageValues;
  readonly current: ImageValues;
}

/**
 * Creates stand-ins for the ports of the image dialog and records of their calls.
 *
 * @param root The editor root.
 * @param overrides Ports to override.
 * @returns The ports and the records of opened specs, insertions, updates and diagnostics.
 */
function createPorts(root: Element, overrides: PortOverrides = {}): {
  ports: ImageDialogPorts;
  opened: ActionDialogSpec[];
  inserted: ImageValues[];
  updated: UpdateCall[];
  diagnostics: string[];
} {
  const opened: ActionDialogSpec[] = [];
  const inserted: ImageValues[] = [];
  const updated: UpdateCall[] = [];
  const diagnostics: string[] = [];
  const ports: ImageDialogPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    openDialog: async (spec): Promise<ActionDialogResult> => {
      opened.push(spec);
      if (overrides.cancelled === true) {
        return { confirmed: false };
      }
      return { confirmed: true, values: overrides.confirmedValues ?? CONFIRMED_VALUES };
    },
    insertImage: overrides.insertImage ?? ((values) => {
      inserted.push(values);
      return true;
    }),
    updateImage: overrides.updateImage ?? ((image, values, current) => {
      updated.push({ image, values, current });
      return true;
    }),
    localizer: LOCALIZER,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, opened, inserted, updated, diagnostics };
}

/**
 * Selects the whole of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element.
 */
function selectElement(root: Element, selector: string): void {
  const range = document.createRange();
  range.selectNode(readElement(root, selector));
  select(range);
}

/**
 * Reads the parts of an opened spec that tell the insert state from the edit state.
 *
 * @param spec The opened spec.
 * @returns The title, the confirm label and the initial values of the fields in order.
 */
function readSpec(spec: ActionDialogSpec | undefined): unknown {
  return {
    title: spec?.title,
    confirmLabel: spec?.confirmLabel,
    initialValues: spec?.fields.map((field) => field.initialValue),
  };
}

/**
 * Places the caret in the first child text of an element.
 *
 * @param root The editor root.
 * @param selector The selector of the element holding the text.
 * @param offset The position within the text.
 */
function placeCaretIn(root: Element, selector: string, offset: number): void {
  const text = readChildText(readElement(root, selector), 0);
  select(createRange(text, offset, text, offset));
}

/**
 * Validates the field values after removing surrounding whitespace, the same as confirming the dialog.
 *
 * @param fields A map from input field names to values. A missing field counts as empty.
 * @returns The rejection, or `undefined` when the values pass.
 */
function validate(fields: Readonly<Record<string, string>>): string | undefined {
  return validateImageValues(readImageValues(fields), LOCALIZER);
}

describe('preconditions for opening the image dialog', () => {
  it('does not call the port that opens the dialog while input is stopped', async () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const { ports, opened } = createPorts(root, { isInputStopped: () => true });

    await openImageDialog(ports);

    expect(opened).toEqual([]);
  });

  it('does not call the port that opens the dialog during a composition', async () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const { ports, opened } = createPorts(root, { isComposing: () => true });

    await openImageDialog(ports);

    expect(opened).toEqual([]);
  });

  it('does not call the port that opens the dialog when the selection is outside the editor root', async () => {
    const root = mountRoot('<p>ab</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    const text = readChildText(outside, 0);
    select(createRange(text, 1, text, 1));
    const { ports, opened } = createPorts(root);

    await openImageDialog(ports);

    expect(opened).toEqual([]);
  });

  it('does not call the port that opens the dialog when the caret is inside a comment body', async () => {
    const root = mountRoot('<p>x<comment id="c1">y<comment-body>note</comment-body></comment></p>');
    placeCaretIn(root, 'comment-body', 2);
    const { ports, opened } = createPorts(root);

    await openImageDialog(ports);

    expect(opened).toEqual([]);
  });

  it('leaves no rejected Promise and leaves one diagnostic line when the insertion port throws', async () => {
    const root = mountRoot('<p>ab</p>');
    placeCaretIn(root, 'p', 1);
    const { ports, diagnostics } = createPorts(root, {
      insertImage: () => {
        throw new Error('The insertion failed');
      },
    });

    const settled = await openImageDialog(ports).then(() => 'resolved', () => 'rejected');

    expect([settled, diagnostics.length]).toEqual(['resolved', 1]);
  });
});

describe('opening the image dialog on an existing image', () => {
  it('opens a spec with the edit title, the update label and the current values of the image when opened from the image item with a range that selects only an image', async () => {
    const root = mountRoot('<p>x<img src="a.png" alt="s" style="width: 40px;">y</p>');
    selectElement(root, 'img');
    const { ports, opened } = createPorts(root);

    await openImageDialog(ports);

    expect(readSpec(opened[0])).toEqual({
      title: 'imageDialog.editTitle',
      confirmLabel: 'imageDialog.update',
      initialValues: ['a.png', 's', '40', ''],
    });
  });

  it('passes the image, the confirmed values and the current values to the update port without calling the insertion port on confirm with a range that selects only an image', async () => {
    const root = mountRoot('<p>x<img src="a.png" alt="s">y</p>');
    selectElement(root, 'img');
    const { ports, inserted, updated } = createPorts(root, {
      confirmedValues: { source: 'a.png', alt: 'new', width: '', height: '' },
    });

    await openImageDialog(ports);

    expect([inserted, updated]).toEqual([[], [{
      image: readElement(root, 'img'),
      values: { source: 'a.png', alt: 'new', width: '', height: '' },
      current: { source: 'a.png', alt: 's', width: '', height: '' },
    }]]);
  });

  it('does not call the port that opens the dialog from a click while input is stopped or during a composition', async () => {
    const root = mountRoot('<p>x<img src="a.png">y</p>');
    const image = readElement(root, 'img');
    const stopped = createPorts(root, { isInputStopped: () => true });
    const composing = createPorts(root, { isComposing: () => true });

    await openImageEditDialog(stopped.ports, image);
    await openImageEditDialog(composing.ports, image);

    expect([stopped.opened, composing.opened]).toEqual([[], []]);
  });

  it('does not call the port that opens the dialog from a click on an image inside pre', async () => {
    const root = mountRoot('<pre><code>a<img src="a.png">b</code></pre>');
    const { ports, opened } = createPorts(root);

    await openImageEditDialog(ports, readElement(root, 'img'));

    expect(opened).toEqual([]);
  });

  it('does not call the update port when the dialog opened on an image is cancelled', async () => {
    const root = mountRoot('<p>x<img src="a.png" alt="s">y</p>');
    const { ports, opened, updated } = createPorts(root, { cancelled: true });

    await openImageEditDialog(ports, readElement(root, 'img'));

    expect([opened.length, updated]).toEqual([1, []]);
  });

  it('leaves no rejected Promise and leaves one diagnostic line when the update port throws', async () => {
    const root = mountRoot('<p>x<img src="a.png" alt="s">y</p>');
    const image = readElement(root, 'img');
    const { ports, diagnostics } = createPorts(root, {
      updateImage: () => {
        throw new Error('The update failed');
      },
    });

    const settled = await openImageEditDialog(ports, image).then(() => 'resolved', () => 'rejected');

    expect([settled, diagnostics.length]).toEqual(['resolved', 1]);
  });
});

describe('validating the image path or URL', () => {
  it('passes the relative paths sample.png, images/a.png and ../../a.png, which goes up', () => {
    const sources = ['sample.png', 'images/a.png', '../../a.png'];

    expect(sources.map((source) => validate({ source }))).toEqual(sources.map(() => undefined));
  });

  it('passes http:// and https:// URLs with a host, even with the scheme in uppercase', () => {
    const sources = [
      'http://example.test/a.png',
      'https://example.test/a.png',
      'HTTP://example.test/a.png',
      'HTTPS://example.test/a.png',
    ];

    expect(sources.map((source) => validate({ source }))).toEqual(sources.map(() => undefined));
  });

  it('rejects an empty or whitespace-only path or URL with the reason asking for a path or URL', () => {
    expect([validate({ source: '' }), validate({ source: ' \t　' })])
      .toEqual(['imageDialog.sourceRequired', 'imageDialog.sourceRequired']);
  });

  it('rejects a path or URL containing U+0001 or DEL in the middle with the reason that the value cannot be used', () => {
    expect([
      validate({ source: 'a\u0001b.png' }),
      validate({ source: 'https://example.test/a\u007Fb.png' }),
    ]).toEqual(['imageDialog.sourceUnsafe', 'imageDialog.sourceUnsafe']);
  });

  it('rejects javascript:, data: and file: values and C:\\a.png with the reason asking for a relative path or an http or https URL', () => {
    const sources = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///C:/a.png', 'C:\\a.png'];

    expect(sources.map((source) => validate({ source })))
      .toEqual(sources.map(() => 'imageDialog.sourceInvalid'));
  });

  it('rejects values starting with /, \\, //, # or ? with the reason asking for a relative path or an http or https URL', () => {
    const sources = ['/a.png', '\\a.png', '//example.test/a.png', '#a', '?a=1'];

    expect(sources.map((source) => validate({ source })))
      .toEqual(sources.map(() => 'imageDialog.sourceInvalid'));
  });

  it('rejects http:a.png and https:// without a host with the reason asking for a relative path or an http or https URL', () => {
    expect([validate({ source: 'http:a.png' }), validate({ source: 'https://' })])
      .toEqual(['imageDialog.sourceInvalid', 'imageDialog.sourceInvalid']);
  });

  it('passes relative paths containing spaces or non-ASCII characters (my photo.png, a path in Japanese)', () => {
    // The second value is a path whose directory and file name are written in kanji.
    expect([validate({ source: 'my photo.png' }), validate({ source: '図/構成.png' })])
      .toEqual([undefined, undefined]);
  });
});

describe('reading the image values', () => {
  it('removes full-width spaces and line breaks around the path or URL, width and height', () => {
    expect(readImageValues({ source: '　a.png\n', alt: 'x', width: '\n40　', height: '　30\n' }))
      .toEqual({ source: 'a.png', alt: 'x', width: '40', height: '30' });
  });
});

describe('validating the width and height', () => {
  it('rejects a width of 320px, 50%, 0, 1.5, -1 or full-width ３２０ with the reason asking for a whole number of 1 or more', () => {
    const widths = ['320px', '50%', '0', '1.5', '-1', '３２０'];

    expect(widths.map((width) => validate({ source: 'a.png', width })))
      .toEqual(widths.map(() => 'imageDialog.widthInvalid'));
  });

  it('rejects a height of 320px with the reason asking for a whole number of 1 or more', () => {
    expect(validate({ source: 'a.png', height: '320px' })).toBe('imageDialog.heightInvalid');
  });

  it('passes an empty or whitespace-only width and height', () => {
    expect([
      validate({ source: 'a.png', width: '', height: '' }),
      validate({ source: 'a.png', width: ' ', height: '　\n' }),
    ]).toEqual([undefined, undefined]);
  });
});

describe('validating the current values of an image being edited', () => {
  it('rejects confirming unchanged the spec opened on an image whose current path is data:, with the reason asking for a relative path or an http or https URL', async () => {
    const root = mountRoot('<p><img src="data:image/png;base64,AAAA"></p>');
    const { ports, opened } = createPorts(root);

    await openImageEditDialog(ports, readElement(root, 'img'));

    const fields = opened[0]?.fields ?? [];
    const initialValues = Object.fromEntries(fields.map((field) => [field.name, field.initialValue]));
    expect(opened[0]?.validate?.(initialValues)).toBe('imageDialog.sourceInvalid');
  });
});

describe('the requirement of the image dialog fields', () => {
  it.each([
    ['inserting', undefined],
    ['editing', { source: 'a.png', alt: '', width: '', height: '' }],
  ])('marks only the path or URL as required and the other three as optional when %s', (_state, current) => {
    const spec = buildImageDialogSpec(LOCALIZER, current);

    expect(spec.fields.map((field) => [field.name, field.required])).toEqual([
      ['source', true],
      ['alt', false],
      ['width', false],
      ['height', false],
    ]);
  });

  it('gives the requirement badge texts', () => {
    expect(buildImageDialogSpec(LOCALIZER).requirementLabels).toEqual({
      required: 'actionDialog.required',
      optional: 'actionDialog.optional',
    });
  });
});

describe('order of rejections', () => {
  it('returns the path or URL reason when both the path or URL and the width are invalid', () => {
    expect(validate({ source: 'javascript:alert(1)', width: '320px' })).toBe('imageDialog.sourceInvalid');
  });

  it('returns the width reason when both the width and the height are invalid', () => {
    expect(validate({ source: 'a.png', width: '0', height: '0' })).toBe('imageDialog.widthInvalid');
  });

  it('does not change the validation result whatever is entered as alt text', () => {
    const alts = ['', 'javascript:alert(1)', 'a\u0001b', '320px', '<img src=x>'];

    expect(alts.map((alt) => [validate({ source: 'a.png', alt }), validate({ source: '', alt })]))
      .toEqual(alts.map(() => [undefined, 'imageDialog.sourceRequired']));
  });
});
