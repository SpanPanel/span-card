import { describe, it, expect, vi } from "vitest";
import { coalesceRuns, makeRenderToken } from "../src/panel/coalesce.js";

// ---------------------------------------------------------------------------
// coalesceRuns
// ---------------------------------------------------------------------------

describe("coalesceRuns", () => {
  it("single call → work runs exactly once", async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    const schedule = coalesceRuns(work);

    await schedule();

    expect(work).toHaveBeenCalledTimes(1);
  });

  it("two concurrent calls → work runs twice (once in-flight, one follow-up)", async () => {
    let resolveFirst!: () => void;
    const firstRunStarted = new Promise<void>(res => {
      resolveFirst = res;
    });

    let releaseFirst!: () => void;
    const firstRunGate = new Promise<void>(res => {
      releaseFirst = res;
    });

    const callOrder: number[] = [];
    let callCount = 0;

    const work = vi.fn().mockImplementation(async () => {
      callCount++;
      const thisCall = callCount;
      callOrder.push(thisCall);
      if (thisCall === 1) {
        resolveFirst();
        await firstRunGate;
      }
    });

    const schedule = coalesceRuns(work);

    // Start caller 1 — it will block until we release the gate
    const p1 = schedule();

    // Wait until work has actually started so the in-flight flag is set
    await firstRunStarted;

    // Caller 2 arrives while caller 1 is in-flight
    const p2 = schedule();
    // Caller 3 also arrives — should collapse into the same follow-up
    const p3 = schedule();

    // Release caller 1
    releaseFirst();

    await Promise.all([p1, p2, p3]);

    // Work should have run exactly twice: the original + one follow-up
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("multiple concurrent arrivals → still only 2 total runs", async () => {
    let releaseFirst!: () => void;
    const firstRunGate = new Promise<void>(res => {
      releaseFirst = res;
    });
    let firstStarted!: () => void;
    const firstRunStarted = new Promise<void>(res => {
      firstStarted = res;
    });

    let runCount = 0;
    const work = vi.fn().mockImplementation(async () => {
      runCount++;
      if (runCount === 1) {
        firstStarted();
        await firstRunGate;
      }
    });

    const schedule = coalesceRuns(work);
    const p1 = schedule();

    await firstRunStarted;

    // Fire five more while p1 is in-flight
    const extras = Array.from({ length: 5 }, () => schedule());

    releaseFirst();
    await Promise.all([p1, ...extras]);

    expect(work).toHaveBeenCalledTimes(2);
  });

  it("work throwing → in-flight flag clears, next call runs successfully", async () => {
    let shouldThrow = true;
    const work = vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error("boom");
    });

    const schedule = coalesceRuns(work);

    await expect(schedule()).rejects.toThrow("boom");

    // After failure, the scheduler should be free to run again
    shouldThrow = false;
    await expect(schedule()).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("work throwing with a follow-up pending → follow-up still runs", async () => {
    let resolveFirst!: () => void;
    const firstRunGate = new Promise<void>(res => {
      resolveFirst = res;
    });
    let firstStarted!: () => void;
    const firstRunStarted = new Promise<void>(res => {
      firstStarted = res;
    });

    let callCount = 0;
    const work = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        firstStarted();
        await firstRunGate;
        throw new Error("boom");
      }
    });

    const schedule = coalesceRuns(work);
    const p1 = schedule();
    await firstRunStarted;

    // Caller 2 arrives while caller 1 is in-flight
    const p2 = schedule();

    // Release caller 1 — it will throw
    resolveFirst();

    // p1 rejects; p2 resolves (it awaited inFlight.catch())
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBeUndefined();

    // Work should have run twice: the original (threw) + one follow-up (succeeded)
    expect(work).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// makeRenderToken
// ---------------------------------------------------------------------------

describe("makeRenderToken", () => {
  it("first call: superseded() returns false before another beginRun", () => {
    const beginRun = makeRenderToken();
    const superseded = beginRun();
    expect(superseded()).toBe(false);
  });

  it("after a second beginRun, first superseded() returns true", () => {
    const beginRun = makeRenderToken();
    const superseded1 = beginRun();
    beginRun(); // second render begins
    expect(superseded1()).toBe(true);
  });

  it("second superseded() continues to return false", () => {
    const beginRun = makeRenderToken();
    beginRun(); // first render
    const superseded2 = beginRun(); // second render
    expect(superseded2()).toBe(false);
  });

  it("each factory instance has independent counter state", () => {
    const beginRunA = makeRenderToken();
    const beginRunB = makeRenderToken();

    const supersededA = beginRunA();
    beginRunB(); // advances B's counter, not A's
    beginRunB();

    // A's token should still be valid
    expect(supersededA()).toBe(false);
  });
});
