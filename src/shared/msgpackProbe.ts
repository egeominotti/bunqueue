/**
 * The probe packer behind `packWithByteViews`' fast path (see msgpackByteViews.ts):
 * msgpackr's default packer whose `moreTypes` option is a getter that returns
 * false and counts how often msgpackr asked for it.
 */

import { pack, Packr } from 'msgpackr';

/**
 * How often the probe packer met a value whose encoding depends on `moreTypes`.
 * A counter rather than a flag, so a nested encode cannot hide an outer read.
 */
let moreTypesReads = 0;

/** Reads so far; compare two values to learn whether an encode in between read it. */
export function moreTypesReadCount(): number {
  return moreTypesReads;
}

class ProbePackr extends Packr {
  /** Read by msgpackr only for the value types listed in msgpackByteViews.ts. */
  get moreTypes(): boolean {
    moreTypesReads++;
    return false;
  }
}

/** The probe packer, or null if this msgpackr no longer behaves as the fast path assumes. */
function createProbe(): Packr | null {
  try {
    const probe = new ProbePackr({ useRecords: false });
    const plain = { a: [1, 'x', null, true, 1.5], d: new Date(0), b: Buffer.from([1]) };
    const before = moreTypesReads;
    const plainBytes = Buffer.from(probe.pack(plain));
    if (moreTypesReads !== before || !plainBytes.equals(Buffer.from(pack(plain)))) return null;
    probe.pack(new Uint16Array(1));
    const afterTypedArray = moreTypesReads;
    probe.pack(new DataView(new ArrayBuffer(1)));
    return afterTypedArray !== before && moreTypesReads !== afterTypedArray ? probe : null;
  } catch {
    return null;
  }
}

export const probe = createProbe();
