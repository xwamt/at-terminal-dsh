/**
 * Backpressure for the terminal stream (the quantity the DSH-25 spike measured).
 *
 * One counter of **produced-but-not-yet-rendered bytes**: frames arriving from
 * the socket add to it, xterm's write callbacks subtract from it. Crossing the
 * pause threshold tells the Host to stop pulling from the SSH channel
 * (`terminal.pause {paused:true}` → `SshSession.pauseOutput`), and falling back
 * under the resume threshold releases it. The gap between the two thresholds is
 * what keeps a producer oscillating at the boundary from flapping the SSH
 * channel on every frame.
 *
 * Pure by construction — no socket, no timer — so the thresholds and the
 * flapping guard are unit-tested rather than observed once in a browser.
 */

export const PAUSE_BYTES = 256 * 1024;
export const RESUME_BYTES = 64 * 1024;

export interface FlowController {
  /** Bytes received from the Host but not yet consumed by the renderer. */
  produced(bytes: number): void;
  /** Bytes the renderer consumed (xterm's write callback). */
  rendered(bytes: number): void;
  /** Drop the counter without emitting a resume (a new connection starts clean). */
  reset(): void;
  readonly paused: boolean;
  readonly outstanding: number;
}

export interface FlowControllerOptions {
  pauseBytes?: number;
  resumeBytes?: number;
  /** Called on every edge, with the new state — the caller sends the wire frame. */
  onPauseChange(paused: boolean): void;
}

export function createFlowController(options: FlowControllerOptions): FlowController {
  const pauseAt = options.pauseBytes ?? PAUSE_BYTES;
  const resumeAt = options.resumeBytes ?? RESUME_BYTES;
  let outstanding = 0;
  let paused = false;

  return {
    produced(bytes: number): void {
      if (bytes <= 0) return;
      outstanding += bytes;
      if (!paused && outstanding > pauseAt) {
        paused = true;
        options.onPauseChange(true);
      }
    },
    rendered(bytes: number): void {
      if (bytes <= 0) return;
      outstanding = Math.max(0, outstanding - bytes);
      if (paused && outstanding < resumeAt) {
        paused = false;
        options.onPauseChange(false);
      }
    },
    reset(): void {
      outstanding = 0;
      if (paused) {
        paused = false;
        // No frame: a fresh connection opens unpaused on the Host, and sending a
        // resume for a socket that was replaced would be noise at best.
      }
    },
    get paused(): boolean {
      return paused;
    },
    get outstanding(): number {
      return outstanding;
    }
  };
}