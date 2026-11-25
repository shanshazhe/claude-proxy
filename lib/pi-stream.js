"use strict";

const { upstreamError } = require("./upstream-error");

// Client disconnects abort the whole upstream request with an HTTP-like status.
function createRequestController(control) {
  const controller = new AbortController();
  if (control) control.abort = (message, status = 499) => controller.abort(Object.assign(new Error(message), { status }));
  return controller;
}

// Shared Pi stream loop for every provider adapter. Pi 1.6 reads provider events ahead of
// its iterable consumer, so each raw event waits for the previous client delivery.
async function streamPi(models, model, context, { signal, label, toError, deliver, onProviderEvent = () => {}, ...options }) {
  let delivery = Promise.resolve();
  const events = models.stream(model, context, { ...options, signal, async onProviderStreamEvent(event) {
    await new Promise((resolve) => setImmediate(resolve));
    await delivery;
    signal.throwIfAborted();
    await onProviderEvent(event);
  } });
  let result;
  try {
    for await (const event of events) {
      signal.throwIfAborted();
      if (event.type === "error") throw toError(event.error.errorMessage);
      if (event.type === "toolcall_end" && event.toolCall.argumentsError) throw upstreamError({ message: `${label} returned invalid tool arguments` });
      if (event.type === "done") result = event.message;
      delivery = deliver(event);
      await delivery;
    }
    signal.throwIfAborted();
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  }
  if (!result) throw upstreamError({ message: `${label} stream ended without a complete response` });
  return result;
}

module.exports = { createRequestController, streamPi };
