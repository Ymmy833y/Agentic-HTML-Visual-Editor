import type { EditUnitId } from '../../common/index';

// Number of random bytes used for one factory's prefix. Avoiding collisions is enough; unpredictability is not needed.
const PREFIX_BYTE_LENGTH = 8;

/**
 * Creates a per-factory prefix.
 *
 * @returns Hexadecimal string.
 */
function createPrefix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PREFIX_BYTE_LENGTH));

  let prefix = '';
  for (const byte of bytes) {
    prefix += byte.toString(16).padStart(2, '0');
  }
  return prefix;
}

/**
 * Creates a factory that returns a new edit unit id on every call.
 *
 * Recreating the view restarts the sequence number, so a sequence number alone could produce the same id as
 * an old view's unit still awaiting settlement on the host. With the same id, the old unit's pair would be
 * treated as the settlement of the new unit. A distinct prefix per factory prevents that.
 *
 * @returns Factory with no side effects other than issuing ids.
 */
export function createEditUnitIdFactory(): () => EditUnitId {
  const prefix = createPrefix();
  let issued = 0;

  return () => {
    issued += 1;
    return `${prefix}-${issued}`;
  };
}
