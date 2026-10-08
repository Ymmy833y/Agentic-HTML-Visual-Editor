import { CONFLICT_CHOICE } from '../../common/index';
import type { ConflictChoice, ConflictSides, Localizer } from '../../common/index';
import { buildConflictSidePreview } from './conflict-preview';
import type { ConflictPreviewContext, ConflictSidePreview } from './conflict-preview';
import type { OverlayContent } from './overlay-presenter';

// The class of the overlay's own parts. Matched by the stylesheet, which also hides the action dialog while it is up.
const CONFLICT_RESOLUTION_CLASS = 'conflict-resolution';

// The markers of the parts inside. Matched by the stylesheet.
const REGION_CLASS = 'conflict-region';
const SIDES_CLASS = 'conflict-sides';
const SIDE_CLASS = 'conflict-side';
const SIDE_HEADING_CLASS = 'conflict-side-heading';
const SHOW_HTML_CLASS = 'conflict-show-html';
const CHOICES_CLASS = 'conflict-choices';
const ACTIONS_CLASS = 'conflict-actions';
const SAVE_CLASS = 'conflict-save';

// The choices in the order they are offered.
const CHOICE_ORDER: readonly ConflictChoice[] = [CONFLICT_CHOICE.source, CONFLICT_CHOICE.view, CONFLICT_CHOICE.both];

/** What the overlay's buttons do. */
export interface ConflictOverlayActions {
  /**
   * Called when Save is pressed.
   *
   * @param choices The choice for each conflict region, in document order.
   */
  submit(choices: readonly ConflictChoice[]): void;
  /** Called when Cancel is pressed. */
  cancel(): void;
}

/** One presentation of the conflict regions of a save. */
export interface ConflictPresentation {
  /** Identifies the presentation. Keeps the radio groups of two presentations apart. */
  readonly presentationId: number;
  /** The conflict regions in document order. */
  readonly conflicts: readonly ConflictSides[];
  /** Whether the file changed again after the user chose for an earlier presentation. */
  readonly repeated: boolean;
}

/**
 * Builds the overlay content that asks the user what to keep for each conflict region of a save.
 *
 * Each region shows the file's lines and the editor's lines side by side, and offers three choices as one radio group.
 * Save stays disabled until every region has a choice. There is no default choice, because any default would write
 * one side without the user having looked at it.
 *
 * @param document The view's document.
 * @param localizer The localizer.
 * @param presentation The presentation.
 * @param context The base URIs for images.
 * @param actions What Save and Cancel do.
 * @returns The overlay content. Its body is reused on every render, so the choices survive a re-render.
 */
export function buildConflictOverlay(
  document: Document,
  localizer: Localizer,
  presentation: ConflictPresentation,
  context: Omit<ConflictPreviewContext, 'emptyLabel'>,
  actions: ConflictOverlayActions,
): OverlayContent {
  const previewContext: ConflictPreviewContext = {
    ...context,
    emptyLabel: localizer.getMessage('conflictResolution.empty'),
  };
  const body = document.createElement('div');
  body.className = CONFLICT_RESOLUTION_CLASS;

  const count = presentation.conflicts.length;
  const groups = presentation.conflicts.map((sides, index) => {
    const region = buildRegion(document, localizer, sides, previewContext, {
      name: `conflict-${String(presentation.presentationId)}-${String(index)}`,
      legend: localizer.getMessage('conflictResolution.conflict', { index: index + 1, count }),
    });
    body.append(region.element);
    return region.radios;
  });

  const actionRow = document.createElement('div');
  actionRow.className = ACTIONS_CLASS;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = SAVE_CLASS;
  save.textContent = localizer.getMessage('conflictResolution.save');
  save.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = localizer.getMessage('conflictResolution.cancel');
  actionRow.append(save, cancel);
  body.append(actionRow);

  body.addEventListener('change', () => {
    for (const radios of groups) {
      updateRovingStop(radios);
    }
    save.disabled = readChoices(groups) === undefined;
  });
  save.addEventListener('click', () => {
    const choices = readChoices(groups);
    if (choices !== undefined) {
      actions.submit(choices);
    }
  });
  cancel.addEventListener('click', () => actions.cancel());

  const descriptions = [localizer.getMessage('conflictResolution.description')];
  if (presentation.repeated) {
    descriptions.unshift(localizer.getMessage('conflictResolution.changedAgain'));
  }
  return {
    heading: localizer.getMessage('conflictResolution.heading'),
    descriptions,
    actions: [],
    body,
  };
}

/**
 * Takes over the keys the conflict overlay does not let through.
 *
 * Esc does nothing, as on the other overlays. Undo and redo are kept from reaching VS Code: the save is still holding
 * the operation queue, so an undo pressed while choosing would be applied after the save and take back what the user
 * just saved. A press during composition is left to the IME.
 *
 * @param event The key press.
 */
export function handleConflictOverlayKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) {
    return;
  }
  if (event.key === 'Escape' || isHistoryKey(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * Returns whether the key is undo or redo: Ctrl or Cmd with Z, with Shift+Z, or with Y.
 *
 * Both the character and the physical key are checked, so that a layout whose Z key types another character is
 * caught as well.
 *
 * @param event The key press.
 */
function isHistoryKey(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return false;
  }
  const key = event.key.toLowerCase();
  if (key === 'z' || event.code === 'KeyZ') {
    return true;
  }
  return !event.shiftKey && (key === 'y' || event.code === 'KeyY');
}

/** The names a region's parts are given. */
interface RegionNames {
  /**
   * The name of the radio group, and the prefix of the IDs of the region's sides. It holds the presentation id, so it is
   * unique in the view.
   */
  readonly name: string;
  /** The text of the legend. */
  readonly legend: string;
}

/**
 * Builds one conflict region: the legend, the HTML toggle, the two sides and the radio group.
 *
 * @param document The view's document.
 * @param localizer The localizer.
 * @param sides The region's two sides.
 * @param context The preview context.
 * @param names The names of the parts.
 * @returns The region and its radios in the order of the choices.
 */
function buildRegion(
  document: Document,
  localizer: Localizer,
  sides: ConflictSides,
  context: ConflictPreviewContext,
  names: RegionNames,
): { readonly element: HTMLElement; readonly radios: readonly HTMLInputElement[] } {
  const region = document.createElement('fieldset');
  region.className = REGION_CLASS;
  const legend = document.createElement('legend');
  legend.textContent = names.legend;
  region.append(legend);

  const source = buildConflictSidePreview(document, sides.source, context);
  const view = buildConflictSidePreview(document, sides.view, context);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = SHOW_HTML_CLASS;
  toggle.textContent = localizer.getMessage('conflictResolution.showHtml');
  const showHtml = (pressed: boolean): void => {
    toggle.setAttribute('aria-pressed', String(pressed));
    for (const preview of [source, view]) {
      preview.rendered.hidden = pressed;
      preview.source.hidden = !pressed;
    }
  };
  toggle.addEventListener('click', () => showHtml(toggle.getAttribute('aria-pressed') !== 'true'));
  showHtml(startsAsHtml(source, view));
  region.append(toggle);

  const sidesElement = document.createElement('div');
  sidesElement.className = SIDES_CLASS;
  sidesElement.append(
    buildSide(document, localizer.getMessage('conflictResolution.fileSide'), source, `${names.name}-source`),
    buildSide(document, localizer.getMessage('conflictResolution.editorSide'), view, `${names.name}-view`),
  );
  region.append(sidesElement);

  const choices = document.createElement('div');
  choices.className = CHOICES_CLASS;
  const labels: Record<ConflictChoice, string> = {
    [CONFLICT_CHOICE.source]: localizer.getMessage('conflictResolution.keepFile'),
    [CONFLICT_CHOICE.view]: localizer.getMessage('conflictResolution.keepEditor'),
    [CONFLICT_CHOICE.both]: localizer.getMessage('conflictResolution.keepBoth'),
  };
  const radios = CHOICE_ORDER.map((choice) => {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = names.name;
    radio.value = choice;
    label.append(radio, document.createTextNode(labels[choice]));
    choices.append(label);
    return radio;
  });
  updateRovingStop(radios);
  region.append(choices);

  return { element: region, radios };
}

/**
 * Returns whether a region starts with both sides shown as HTML text.
 *
 * A difference only in tags or attributes does not show in the rendering, so a region whose sides read the same, or
 * whose side with lines shows no text at all, would look like nothing differs.
 *
 * @param source The file's side.
 * @param view The editor's side.
 */
function startsAsHtml(source: ConflictSidePreview, view: ConflictSidePreview): boolean {
  if (source.visibleText === view.visibleText) {
    return true;
  }
  return [source, view].some((side) => side.hasLines && side.visibleText.length === 0);
}

/**
 * Builds one side: its heading and a box that holds the rendering and the HTML text.
 *
 * The box scrolls once the side is taller than its cap. Nothing inside it can take focus, so the box itself is a Tab
 * stop, named by the heading; otherwise a keyboard user could not scroll to the rest of the side.
 *
 * @param document The view's document.
 * @param heading The heading.
 * @param preview The side's preview.
 * @param id A prefix for the IDs of the side, unique in the view.
 * @returns The side.
 */
function buildSide(document: Document, heading: string, preview: ConflictSidePreview, id: string): HTMLElement {
  const side = document.createElement('section');
  side.className = SIDE_CLASS;
  const title = document.createElement('p');
  title.id = `${id}-heading`;
  title.className = SIDE_HEADING_CLASS;
  title.textContent = heading;
  const box = document.createElement('div');
  box.tabIndex = 0;
  box.setAttribute('role', 'region');
  box.setAttribute('aria-labelledby', title.id);
  box.append(preview.rendered, preview.source);
  side.append(title, box);
  return side;
}

/**
 * Leaves one Tab stop in a radio group: the chosen radio, or the first one while none is chosen.
 *
 * The overlay cycles Tab through every element whose tabindex is 0 or more, so without this every radio would be a
 * stop. Arrow keys still move between the radios of a group.
 *
 * @param radios The radios of the group.
 */
function updateRovingStop(radios: readonly HTMLInputElement[]): void {
  const stop = radios.find((radio) => radio.checked) ?? radios[0];
  for (const radio of radios) {
    radio.tabIndex = radio === stop ? 0 : -1;
  }
}

/**
 * Reads the choice of every region.
 *
 * @param groups The radios of each region, in document order.
 * @returns The choices in document order. `undefined` while a region has none.
 */
function readChoices(groups: readonly (readonly HTMLInputElement[])[]): ConflictChoice[] | undefined {
  const choices: ConflictChoice[] = [];
  for (const radios of groups) {
    const index = radios.findIndex((radio) => radio.checked);
    const choice = CHOICE_ORDER[index];
    if (choice === undefined) {
      return undefined;
    }
    choices.push(choice);
  }
  return choices;
}
