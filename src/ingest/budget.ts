import { PermanentJobError } from "../errors.js";

/**
 * Keeps one document from monopolising the event loop that serves every tenant.
 *
 * Parsing and chunking run on the main thread, so they are written as loops that call `due()` and
 * `yield()`: after `sliceMs` of uninterrupted work the loop hands control back (setImmediate) so
 * queued HTTP requests and timers run. `yield()` also adds up the time the document has actually
 * spent computing and aborts it with a permanent (non-retried) error once that passes
 * `maxActiveMs`. Waiting while other work runs does not count against the document.
 *
 * This is cooperative: a single step that never reaches a `due()` check cannot be interrupted.
 * Every loop in the ingestion path is linear in its input and checks often; see `scripts/worst-case.mjs`
 * for measurements. For hard isolation (a hostile parser dependency, say) use a worker thread or process.
 */
export class ProcessingBudget {
  private activeMs = 0;
  private sliceStart: number;

  constructor(
    /** Total active time one document may use before it is rejected. */
    readonly maxActiveMs = 4000,
    /** Longest stretch of work before control goes back to the event loop. */
    private readonly sliceMs = 10,
    /** Millisecond clock; injectable so tests can control time. */
    private readonly now: () => number = () => performance.now(),
  ) {
    this.sliceStart = this.now();
  }

  /** Cheap, synchronous check: has this slice of work run long enough to yield? */
  due(): boolean {
    return this.now() - this.sliceStart >= this.sliceMs;
  }

  /** Total time spent computing so far, in milliseconds. */
  get activeTimeMs(): number {
    return this.activeMs + (this.now() - this.sliceStart);
  }

  /** Lets the event loop run, and rejects the document if it has used up its budget. */
  async yield(): Promise<void> {
    this.activeMs += this.now() - this.sliceStart;
    if (this.activeMs > this.maxActiveMs) {
      throw new PermanentJobError(`document processing used more than ${this.maxActiveMs} ms of CPU time`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sliceStart = this.now();
  }

  /**
   * Awaits something that mostly waits (a network call) without charging the wait to the document. Whatever work the
   * call did synchronously before returning its promise has already been counted.
   */
  async waitFor<T>(pending: Promise<T>): Promise<T> {
    this.activeMs += this.now() - this.sliceStart;
    try {
      return await pending;
    } finally {
      this.sliceStart = this.now();
    }
  }
}
