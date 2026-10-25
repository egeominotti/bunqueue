export const MAX_FRAME_SIZE = 64 * 1024 * 1024;

export class FrameSizeError extends Error {
  constructor(
    public readonly requestedSize: number,
    public readonly maxSize: number
  ) {
    super(`Frame size ${requestedSize} exceeds maximum allowed size ${maxSize}`);
    this.name = 'FrameSizeError';
  }
}

const EMPTY = new Uint8Array(0);

export class FrameParser {
  /** Backing storage; bytes [start, end) are the unparsed tail of the stream. */
  private buffer: Uint8Array = EMPTY;
  private start = 0;
  private end = 0;
  private readonly maxFrameSize: number;

  constructor(maxFrameSize: number = MAX_FRAME_SIZE) {
    this.maxFrameSize = maxFrameSize;
  }

  addData(chunk: Uint8Array): Uint8Array[] {
    // A plain Uint8Array view, so `slice` copies into a Uint8Array even for a Buffer
    // (Buffer#slice returns a view of the socket chunk, and decoded binary fields
    // would become Buffer views instead of Uint8Array copies).
    const data =
      chunk.constructor === Uint8Array
        ? chunk
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // With nothing pending, parse straight from the chunk instead of copying it first.
    const direct = this.start === this.end;
    if (!direct) this.append(data);
    const source = direct ? data : this.buffer;
    const limit = direct ? data.length : this.end;
    let offset = direct ? 0 : this.start;

    const frames: Uint8Array[] = [];
    while (limit - offset >= 4) {
      const length =
        ((source[offset] << 24) |
          (source[offset + 1] << 16) |
          (source[offset + 2] << 8) |
          source[offset + 3]) >>>
        0;

      if (length > this.maxFrameSize) {
        this.clear();
        throw new FrameSizeError(length, this.maxFrameSize);
      }
      if (limit - offset < 4 + length) break;
      frames.push(source.slice(offset + 4, offset + 4 + length));
      offset += 4 + length;
    }

    if (direct) {
      this.start = 0;
      this.end = 0;
      if (offset < limit) this.append(data.subarray(offset));
    } else if (offset >= limit) {
      this.clear();
    } else {
      this.start = offset;
      this.shrinkIfOversized();
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.end - this.start;
  }

  get hasPartialFrame(): boolean {
    return this.end > this.start;
  }

  clear(): void {
    this.buffer = EMPTY;
    this.start = 0;
    this.end = 0;
  }

  /**
   * Append with amortized O(1) growth by doubling. Growth follows bytes actually
   * received, never a length announced in a header, so a peer cannot make the parser
   * reserve a large buffer before sending the data.
   */
  private append(data: Uint8Array): void {
    const pending = this.end - this.start;
    const needed = pending + data.length;
    if (this.end + data.length > this.buffer.length) {
      if (needed <= this.buffer.length) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(needed, this.buffer.length * 2, 4096));
        next.set(this.buffer.subarray(this.start, this.end));
        this.buffer = next;
      }
      this.start = 0;
      this.end = pending;
    }
    this.buffer.set(data, this.end);
    this.end += data.length;
  }

  /** After a large frame, keep only the pending tail instead of the whole grown buffer. */
  private shrinkIfOversized(): void {
    const pending = this.end - this.start;
    if (this.buffer.length <= 65_536 || pending * 4 >= this.buffer.length) return;
    this.buffer = this.buffer.slice(this.start, this.end);
    this.start = 0;
    this.end = pending;
  }

  static frame(data: Uint8Array): Uint8Array {
    const frame = new Uint8Array(4 + data.length);
    frame[0] = (data.length >> 24) & 0xff;
    frame[1] = (data.length >> 16) & 0xff;
    frame[2] = (data.length >> 8) & 0xff;
    frame[3] = data.length & 0xff;
    frame.set(data, 4);
    return frame;
  }
}
