"use strict";

function createNvidiaPacer({ env = process.env, now = () => performance.now() } = {}) {
  const number = (value, fallback) => value && Number.isFinite(Number(value)) ? Number(value) : fallback;
  const rpm = number(env.NVIDIA_GLOBAL_RPM, 100);
  const burst = Math.max(number(env.NVIDIA_GLOBAL_BURST, 1), 1);
  const interval = rpm > 0 ? 60000 / rpm : 0;
  const tolerance = (burst - 1) * interval;
  let next = 0;
  let timer;
  const queue = new Set();

  function drain() {
    clearTimeout(timer);
    timer = undefined;
    for (const entry of queue) {
      const current = now();
      const delay = next - tolerance - current;
      if (delay > 0) {
        timer = setTimeout(drain, Math.min(Math.ceil(delay), 2147483647));
        return;
      }
      queue.delete(entry);
      entry.signal?.removeEventListener("abort", entry.abort);
      // Advance GCRA only when granting a send, using the current time even after a stall.
      next = Math.max(next, current) + interval;
      entry.resolve();
    }
  }

  return async (signal) => {
    signal?.throwIfAborted();
    if (!interval) return;
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, abort: () => {
        queue.delete(entry);
        reject(signal.reason);
        if (!queue.size) { clearTimeout(timer); timer = undefined; }
      } };
      queue.add(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      if (timer === undefined) drain();
    });
  };
}

const paceNvidiaRequest = createNvidiaPacer();
module.exports = { createNvidiaPacer, paceNvidiaRequest };
