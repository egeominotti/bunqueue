import { peekSharedManager } from '../../manager';
import { QueueCompatibility } from './compatibility';

/** Queue batching shutdown and transport cleanup. */
export class QueueConnection<T> extends QueueCompatibility<T> {
  async disconnect(): Promise<void> {
    if (this.addBatcher) {
      await this.addBatcher.flush();
      await this.addBatcher.waitForInFlight();
      this.addBatcher.stop();
    }
    this.close();
  }

  close(): void {
    this.addBatcher?.stop();
    this.releaseConnection();
    // Write the shared manager's buffered inserts so a resolved add() survives an
    // immediate process.exit(). Never creates a manager or revives one that was shut
    // down and leaves its timers running. Best effort and non-throwing: while a write
    // retry backoff is armed it writes nothing and the rows stay under the buffer's
    // retry and critical-loss handling.
    if (this.embedded) peekSharedManager()?.flushPendingWrites();
  }
}
