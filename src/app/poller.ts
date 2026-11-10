import { Observable, Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';

// Runs a request repeatedly, waiting for each response before scheduling the
// next one, and pauses while the tab is hidden.
export class Poller {
  private timeout_id: ReturnType<typeof setTimeout> = null;
  private request_sub: Subscription = null;
  private running = false;

  private readonly onVisibilityChange = (): void => {
    if (!document.hidden && !this.request_sub) {
      this.pollNow();
    }
  };

  constructor(private request: () => Observable<unknown>, private delay_ms: () => number) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.poll();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    clearTimeout(this.timeout_id);
    this.timeout_id = null;
    if (this.request_sub) this.request_sub.unsubscribe();
  }

  pollNow(): void {
    if (!this.running || this.request_sub) return;
    clearTimeout(this.timeout_id);
    this.poll();
  }

  private poll(): void {
    this.timeout_id = null;
    if (!this.running || document.hidden) return;
    let done = false;
    const sub = this.request().pipe(finalize(() => {
      done = true;
      this.request_sub = null;
      this.scheduleNext();
    })).subscribe({ error: () => {} });
    if (!done) this.request_sub = sub;
  }

  private scheduleNext(): void {
    if (!this.running || document.hidden) return;
    this.timeout_id = setTimeout(() => this.poll(), this.delay_ms());
  }
}
