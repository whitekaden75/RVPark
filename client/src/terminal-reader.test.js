import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalReaderMonitor } from "./terminal-reader.js";

function setup(request) {
  const timers = new Map();
  const state = { reader: null, error: "", checking: false };
  let nextTimer = 0;
  const monitor = createTerminalReaderMonitor({
    request,
    onReader: reader => { state.reader = reader; },
    onError: error => { state.error = error; },
    onChecking: checking => { state.checking = checking; },
    schedule: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    cancel: id => timers.delete(id),
  });
  return {
    ...monitor, state, timers,
    fire(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected a timer for ${ms}ms`);
      timers.delete(entry[0]);
      return entry[1].fn();
    },
  };
}
const reader = status => ({ id: "tmr_office", label: "Office", status });

test("refresh discovers a reader and automatically notices it coming online", async () => {
  let calls = 0;
  const monitor = setup(async (path, options) => {
    assert.equal(path, "/stripe/terminal/status");
    assert.equal(options.cache, "no-store");
    return { reader: reader(++calls === 1 ? "offline" : "online") };
  });
  const pending = monitor.refresh();
  assert.equal(monitor.state.checking, true);
  await pending;
  assert.equal(monitor.state.reader.status, "offline");
  assert.equal(monitor.state.checking, false);
  await monitor.fire(15000);
  assert.equal(monitor.state.reader.status, "online");
  assert.equal(calls, 2);
  monitor.stop();
  assert.equal(monitor.timers.size, 0);
});

test("configuration errors are displayed and a manual retry recovers", async () => {
  let calls = 0;
  const monitor = setup(async () => {
    if (++calls === 1) throw new Error("No physical Stripe Terminal reader is visible to the configured Stripe account and mode.");
    return { reader: reader("online") };
  });
  await monitor.refresh();
  assert.equal(monitor.state.reader, null);
  assert.match(monitor.state.error, /configured Stripe account and mode/);
  assert.equal(monitor.state.checking, false);
  await monitor.refresh();
  assert.equal(monitor.state.error, "");
  assert.equal(monitor.state.reader.status, "online");
  assert.equal(monitor.timers.size, 1);
  monitor.stop();
});

test("a stalled check times out, clears stale online status, and recovers on the next poll", async () => {
  let calls = 0;
  let stalledSignal;
  let finishStalled;
  const monitor = setup((_path, { signal }) => {
    if (++calls === 2) {
      stalledSignal = signal;
      return new Promise(resolve => { finishStalled = resolve; });
    }
    return Promise.resolve({ reader: reader("online") });
  });
  await monitor.refresh();
  const stalled = monitor.fire(15000);
  monitor.fire(12000);
  await stalled;
  assert.equal(stalledSignal.aborted, true);
  assert.match(monitor.state.error, /timed out/);
  assert.equal(monitor.state.checking, false);
  assert.equal(monitor.state.reader, null);
  await monitor.fire(15000);
  assert.equal(monitor.state.reader.status, "online");
  assert.equal(monitor.state.error, "");
  finishStalled({ reader: reader("offline") });
  await Promise.resolve();
  assert.equal(monitor.state.reader.status, "online");
  monitor.stop();
});

test("simultaneous refreshes share one check and stopping ignores late responses", async () => {
  let calls = 0;
  let complete;
  let requestSignal;
  const monitor = setup((_path, { signal }) => {
    calls++;
    requestSignal = signal;
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = monitor.refresh();
  assert.equal(monitor.refresh(), pending);
  assert.equal(calls, 1);
  monitor.stop();
  assert.equal(requestSignal.aborted, true);
  await pending;
  complete({ reader: reader("online") });
  await Promise.resolve();
  assert.equal(monitor.state.reader, null);
  assert.equal(monitor.state.error, "");
  assert.equal(monitor.timers.size, 0);
  await monitor.refresh();
  assert.equal(calls, 1);
});

test("missing or invalid reader responses show an error instead of loading forever", async () => {
  for (const result of [null, {}, { reader: {} }, { reader: { id: "tmr_office" } }]) {
    const monitor = setup(async () => result);
    await monitor.refresh();
    assert.equal(monitor.state.reader, null);
    assert.match(monitor.state.error, /did not return a reader status/);
    assert.equal(monitor.state.checking, false);
    monitor.stop();
  }
});
