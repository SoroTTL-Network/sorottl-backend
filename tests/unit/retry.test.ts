import { describe, it, expect, vi } from "vitest";
import { defaultSleep, withRetry } from "../../src/monitoring/retry.js";

describe("Retry Logic and AbortSignal Cancellation", () => {
  it("completes operation immediately if not failing", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("interrupts retry sleep immediately when AbortSignal triggers", async () => {
    const controller = new AbortController();
    let attempts = 0;

    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error("HTTP 503 Server Error");
    });

    const retryPromise = withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 2000,
      signal: controller.signal,
    });

    // Abort after 50ms (well before the 2000ms sleep delay completes)
    setTimeout(() => {
      controller.abort(new Error("Shutdown signal"));
    }, 50);

    const startTime = Date.now();
    await expect(retryPromise).rejects.toThrow(/Shutdown signal/);
    const duration = Date.now() - startTime;

    // Should abort promptly in ~50-200ms, not after full 2000ms delay
    expect(duration).toBeLessThan(1000);
    expect(attempts).toBe(1); // Did not perform unwanted 2nd retry after abort
  });

  it("does not initiate operation if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));

    const fn = vi.fn().mockResolvedValue("should not run");
    await expect(
      withRetry(fn, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Already cancelled/);

    expect(fn).not.toHaveBeenCalled();
  });

  it("defaultSleep cleans up abort event listener upon normal timeout", async () => {
    const controller = new AbortController();
    await defaultSleep(20, controller.signal);
    // If listeners leak, aborting now would throw unhandled rejections
    controller.abort();
  });
});
