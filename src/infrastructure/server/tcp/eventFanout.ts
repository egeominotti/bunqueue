/**
 * Optional per-connection event-type filter of `SubscribeEvents` (`eventTypes`). A
 * connection without one receives every event of its queue, exactly as before; a
 * filtered one receives only the listed types, in the same order. A TCP Worker
 * subscribes for `stalled` only, so the broker no longer encodes and writes, and the
 * worker no longer decodes, the `pulled` and `completed` frames of every job it runs.
 */

/** `null` (or absent): every event type. */
export type EventTypeFilter = ReadonlySet<string> | null;

interface FilteredSubscriber {
  readonly data: { readonly eventTypes?: EventTypeFilter };
}

/** A batch's encoded frames for one queue, with each frame's event type. */
export interface EncodedEvents {
  readonly frames: Uint8Array[];
  readonly types: string[];
}

const MAX_EVENT_TYPES = 32;
const MAX_EVENT_TYPE_LENGTH = 64;

/**
 * Shape check of the optional `eventTypes` field: absent (or null, as SDKs that encode
 * an unset optional field as nil send it), or 1..32 names of 1..64 characters. Names
 * are not checked against the broker's event types, so a client may name a type a
 * newer broker emits; a type this broker never emits simply never matches.
 */
export function validateEventTypes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EVENT_TYPES ||
    !value.every(
      (type) => typeof type === 'string' && type.length > 0 && type.length <= MAX_EVENT_TYPE_LENGTH
    )
  ) {
    return `eventTypes must be an array of 1 to ${MAX_EVENT_TYPES} event type names`;
  }
  return null;
}

export function acceptsEventType(filter: EventTypeFilter | undefined, eventType: string): boolean {
  return !filter || filter.has(eventType);
}

/** The types at least one subscriber receives; `null` as soon as one receives all. */
export function wantedEventTypes(subscribers: Iterable<FilteredSubscriber>): EventTypeFilter {
  const wanted = new Set<string>();
  for (const socket of subscribers) {
    const filter = socket.data.eventTypes;
    if (!filter) return null;
    for (const type of filter) wanted.add(type);
  }
  return wanted;
}

/** One write's bytes for a subscriber: its accepted frames in batch order, or null. */
export function framesFor(encoded: EncodedEvents, filter: ReadonlySet<string>): Uint8Array | null {
  let selected: Uint8Array[] | null = null;
  for (let index = 0; index < encoded.frames.length; index++) {
    if (filter.has(encoded.types[index])) (selected ??= []).push(encoded.frames[index]);
  }
  return selected ? joinFrames(selected) : null;
}

export function joinFrames(frames: readonly Uint8Array[]): Uint8Array {
  return frames.length === 1 ? frames[0] : concatFrames(frames);
}

/** One buffer holding `frames` back to back. */
function concatFrames(frames: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const frame of frames) length += frame.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}
