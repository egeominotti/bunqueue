/**
 * Generic Min-Heap implementation with 4-ary branching
 * 4-ary heap provides better cache locality than binary heap:
 * - Children are stored closer together in memory
 * - Reduces cache misses during bubbleDown (most frequent operation)
 * - 4 comparisons per level vs 2, but fewer levels to traverse
 *
 * O(log₄ n) push/pop, O(1) peek
 */

export class MinHeap<T> {
  private heap: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  /** Branching factor - 4 provides optimal cache performance on modern CPUs */
  private static readonly D = 4;

  /**
   * Create a min-heap with custom comparator
   * @param compare Returns negative if a < b, positive if a > b, 0 if equal
   */
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  /** Get current size */
  get size(): number {
    return this.heap.length;
  }

  /** Check if empty */
  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** Push item - O(log n) */
  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  /** Pop minimum item - O(log n) */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    const last = this.heap.pop();
    if (last !== undefined) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return min;
  }

  /** Peek at minimum without removing - O(1) */
  peek(): T | undefined {
    return this.heap[0];
  }

  /** Clear the heap */
  clear(): void {
    this.heap = [];
  }

  /** Get all items (for iteration) */
  toArray(): T[] {
    return [...this.heap];
  }

  /** Rebuild heap from array - O(n) */
  buildFrom(items: T[]): void {
    this.heap = [...items];
    // Heapify from bottom up - start from last non-leaf node
    // In D-ary heap, last non-leaf is at floor((n-2)/D)
    const D = MinHeap.D;
    for (let i = Math.floor((this.heap.length - 2) / D); i >= 0; i--) {
      this.bubbleDown(i);
    }
  }

  /** Remove item by predicate - O(n) */
  removeWhere(predicate: (item: T) => boolean): T | undefined {
    const idx = this.heap.findIndex(predicate);
    if (idx === -1) return undefined;

    const item = this.heap[idx];
    if (idx === this.heap.length - 1) {
      this.heap.pop();
    } else {
      const last = this.heap.pop();
      if (last !== undefined) {
        this.heap[idx] = last;
        // Try both directions since we don't know the relative order
        this.bubbleUp(idx);
        this.bubbleDown(idx);
      }
    }
    return item;
  }

  /** 4-ary bubbleUp: parent at floor((idx-1)/4) */
  private bubbleUp(idx: number): void {
    const D = MinHeap.D;
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / D);
      if (this.compare(this.heap[idx], this.heap[parentIdx]) >= 0) break;
      this.swap(idx, parentIdx);
      idx = parentIdx;
    }
  }

  /** 4-ary bubbleDown: children at D*idx+1 through D*idx+D */
  private bubbleDown(idx: number): void {
    const D = MinHeap.D;
    const length = this.heap.length;
    const heap = this.heap;
    const compare = this.compare;

    while (true) {
      const firstChild = D * idx + 1;
      if (firstChild >= length) break;

      // Find minimum among up to D children (cache-friendly sequential access)
      let smallest = idx;
      const lastChild = Math.min(firstChild + D, length);

      for (let c = firstChild; c < lastChild; c++) {
        if (compare(heap[c], heap[smallest]) < 0) {
          smallest = c;
        }
      }

      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}
