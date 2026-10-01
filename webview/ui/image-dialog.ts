import { isRelativeFileHref, trimHref } from '../../common/index';
import type { Localizer } from '../../common/index';
import { readSelectionRange } from '../editing/caret';
import { findSelectedImage, readCurrentImageValues } from '../editing/image-edit';
import type { ImageValues } from '../editing/image-insert';
import { isFormattingExcluded } from '../editing/inline-format';
import { buildRequirementLabels } from './action-dialog';
import type { ActionDialogResult, ActionDialogSpec } from './action-dialog';

// The names of the input fields. Also used to look up the input values in the result.
const FIELD_NAME = {
  source: 'source',
  alt: 'alt',
  width: 'width',
  height: 'height',
} as const;

// C0 control characters and DEL. URL parsing skips tabs and line breaks in the middle of a value, so a
// value judged to be a relative path, such as `java\tscript:`, can still have a scheme.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

// The start of an http or https URL. The case of the scheme does not matter.
const HTTP_URL_PREFIX_PATTERN = /^https?:\/\//iu;

// A run of ASCII digits only. Values containing full-width digits, signs, decimal points or units do not match.
const DIGITS_PATTERN = /^[0-9]+$/u;

/**
 * The ports of the image dialog.
 *
 * They hold no values and are read on every call. The editing session changes with a document replacement,
 * and the input stop changes from moment to moment.
 */
export interface ImageDialogPorts {
  /** Returns the editor root. `undefined` before the mount. */
  readEditorRoot(): Element | undefined;

  /** Whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Opens the action dialog and waits for the result.
   *
   * @param spec The action dialog spec.
   * @returns The result, resolved after the selection is returned.
   */
  openDialog(spec: ActionDialogSpec): Promise<ActionDialogResult>;

  /**
   * Inserts an image at the selection. The callee owns the precondition checks and the edit attempt.
   *
   * @param values The image values with surrounding whitespace removed.
   * @returns Whether the tree was changed.
   */
  insertImage(values: ImageValues): boolean;

  /**
   * Rewrites an existing image with the fields changed from its current values. The callee owns the precondition
   * checks and the edit attempt.
   *
   * @param image The image to rewrite.
   * @param values The image values with surrounding whitespace removed.
   * @param current The current values the dialog opened with.
   * @returns Whether the tree was changed.
   */
  updateImage(image: Element, values: ImageValues, current: ImageValues): boolean;

  /** The localizer. */
  readonly localizer: Localizer;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;
}

/**
 * Checks the preconditions for inserting an image, opens the image dialog and, on confirm, passes the image
 * values on to the insertion. A range that selects only an image opens the dialog on that image instead.
 *
 * Waiting for the result and exceptions from the insertion are kept inside, because the caller (the toolbar)
 * calls this and moves on without waiting for the result.
 *
 * @param ports The ports of the image dialog.
 * @returns Resolves once the insertion or the update finishes, or once nothing is done because the
 *   preconditions are not met. It does not reject on exceptions from waiting for the result, from the
 *   insertion or from the update, and leaves one diagnostic line instead.
 */
export async function openImageDialog(ports: ImageDialogPorts): Promise<void> {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return;
  }
  const range = readSelectionRange(root);
  // Do not open where an image cannot go. Opening there would have the user type values that are not
  // inserted even when confirmed. For a range, look at the start, where the caret remains after the delete.
  if (range === undefined || isFormattingExcluded(range.startContainer, root)) {
    return;
  }

  try {
    // Replacing a selected image would make the user enter every field again to fix one of them, so the image
    // is edited instead. Its own preconditions are checked again, since the range may start outside pre while
    // the image sits inside it.
    const image = findSelectedImage(range);
    if (image !== undefined) {
      await openImageEditDialog(ports, image);
      return;
    }
    const result = await ports.openDialog(buildImageDialogSpec(ports.localizer));
    // Do nothing on cancel (Esc, the cancel button, or a replacement of the displayed tree).
    if (!result.confirmed) {
      return;
    }
    ports.insertImage(readImageValues(result.values));
  } catch (error) {
    ports.reportDiagnostic(`Could not insert the result of the image dialog: ${String(error)}`);
  }
}

/**
 * Checks the preconditions for editing an existing image, opens the image dialog with the image's current values
 * and, on confirm, passes the image values on to the update of that image.
 *
 * Waiting for the result and exceptions from the update are kept inside, because the callers (a click on the image
 * and the toolbar) call this and move on without waiting for the result.
 *
 * @param ports The ports of the image dialog.
 * @param image The image to edit.
 * @returns Resolves once the update finishes, or once nothing is done because the preconditions are not met. It
 *   does not reject on exceptions from reading the current values, waiting for the result or the update, and leaves
 *   one diagnostic line instead.
 */
export async function openImageEditDialog(ports: ImageDialogPorts, image: Element): Promise<void> {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return;
  }
  // An image where no image can be inserted is not edited either, so the dialog is not opened for it.
  if (!root.contains(image) || isFormattingExcluded(image, root)) {
    return;
  }

  try {
    const current = readCurrentImageValues(image);
    const result = await ports.openDialog(buildImageDialogSpec(ports.localizer, current));
    // Do nothing on cancel (Esc, the cancel button, or a replacement of the displayed tree).
    if (!result.confirmed) {
      return;
    }
    ports.updateImage(image, readImageValues(result.values), current);
  } catch (error) {
    ports.reportDiagnostic(`Could not apply the result of the image dialog to the image: ${String(error)}`);
  }
}

/**
 * Builds the spec of the image dialog.
 *
 * Without current values it is the insert state, with empty fields. With the current values of an existing image
 * it is the edit state, whose title and confirm label say that the image is updated. Both states validate the same
 * way, so a current value that does not pass has to be fixed before confirming.
 *
 * @param localizer The localizer.
 * @param current The current values of the image being edited. Omitted when inserting.
 * @returns The action dialog spec.
 */
export function buildImageDialogSpec(localizer: Localizer, current?: ImageValues): ActionDialogSpec {
  const editing = current !== undefined;
  return {
    title: localizer.getMessage(editing ? 'imageDialog.editTitle' : 'imageDialog.title'),
    fields: [
      {
        name: FIELD_NAME.source,
        label: localizer.getMessage('imageDialog.source'),
        initialValue: current?.source ?? '',
        required: true,
      },
      {
        name: FIELD_NAME.alt,
        label: localizer.getMessage('imageDialog.alt'),
        initialValue: current?.alt ?? '',
        required: false,
      },
      {
        name: FIELD_NAME.width,
        label: localizer.getMessage('imageDialog.width'),
        initialValue: current?.width ?? '',
        required: false,
      },
      {
        name: FIELD_NAME.height,
        label: localizer.getMessage('imageDialog.height'),
        initialValue: current?.height ?? '',
        required: false,
      },
    ],
    requirementLabels: buildRequirementLabels(localizer),
    confirmLabel: localizer.getMessage(editing ? 'imageDialog.update' : 'imageDialog.insert'),
    cancelLabel: localizer.getMessage('imageDialog.cancel'),
    validate: (values) => validateImageValues(readImageValues(values), localizer),
  };
}

/**
 * Turns the values of the input fields into image values with surrounding whitespace removed.
 *
 * Both the validation and the insertion use these values. If they were trimmed differently, the value that
 * was validated and the value put into the document would disagree. The source is trimmed the same way as
 * the relative link check, and the other fields are trimmed by one shared definition.
 *
 * @param values A map from input field names to values. A missing field counts as empty.
 * @returns The image values with surrounding whitespace removed.
 */
export function readImageValues(values: Readonly<Record<string, string>>): ImageValues {
  return {
    source: trimHref(values[FIELD_NAME.source] ?? ''),
    alt: (values[FIELD_NAME.alt] ?? '').trim(),
    width: (values[FIELD_NAME.width] ?? '').trim(),
    height: (values[FIELD_NAME.height] ?? '').trim(),
  };
}

/**
 * Validates the image values. The image values are left unchanged.
 *
 * The source passes only as a relative path or as an http or https URL with a host. Dangerous URL schemes
 * and `data:` do not fit these forms, so they are rejected without a separate check. It does not check that
 * the file exists or that it stays inside the range under the resource root. Checking existence needs a
 * round trip to the host. The resource root depends on which workspace the document is opened in, so a
 * value outside that range is not necessarily a mistake. Only the first reason found is returned, in the field order of source, width and
 * height.
 *
 * @param values The image values with surrounding whitespace removed.
 * @param localizer The localizer.
 * @returns The rejection, or `undefined` when the values pass.
 */
export function validateImageValues(values: ImageValues, localizer: Localizer): string | undefined {
  const source = values.source;
  if (source === '') {
    return localizer.getMessage('imageDialog.sourceRequired');
  }
  if (CONTROL_CHARACTER_PATTERN.test(source)) {
    return localizer.getMessage('imageDialog.sourceUnsafe');
  }
  if (!isRelativeFileHref(source) && !isHttpUrl(source)) {
    return localizer.getMessage('imageDialog.sourceInvalid');
  }
  if (values.width !== '' && !isPixelSize(values.width)) {
    return localizer.getMessage('imageDialog.widthInvalid');
  }
  if (values.height !== '' && !isPixelSize(values.height)) {
    return localizer.getMessage('imageDialog.heightInvalid');
  }
  return undefined;
}

/**
 * Determines whether a value is an http or https URL with a host.
 *
 * The value must start with `http://` or `https://`. URL parsing reads `http:a.png` as `http://a.png/` and
 * gives it a host, but a user who wrote that did not necessarily mean a URL.
 *
 * @param value The value with surrounding whitespace removed.
 * @returns `true` for an http or https URL with a host.
 */
function isHttpUrl(value: string): boolean {
  if (!HTTP_URL_PREFIX_PATTERN.test(value)) {
    return false;
  }
  try {
    return new URL(value).host !== '';
  } catch {
    return false;
  }
}

/**
 * Determines whether a value can be written as a width or height.
 *
 * The value is written as is as a px value in `style`. Limiting it to digits keeps both units and other
 * declarations from being slipped in.
 *
 * @param value A non-empty value with surrounding whitespace removed.
 * @returns `true` for a whole number of 1 or more made only of ASCII digits.
 */
function isPixelSize(value: string): boolean {
  return DIGITS_PATTERN.test(value) && Number(value) >= 1;
}
