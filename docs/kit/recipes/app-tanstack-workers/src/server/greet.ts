// The binding: validate, resolve the Caller, open the span, call the port.
// Transport only — no logic lives here.
import { createServerFn } from "@tanstack/react-start";
import { greet, greetInput } from "../port/greet";
import { inSpan } from "../telemetry/span";
import { workersTracer } from "../telemetry/workers-tracer";

export const greetFn = createServerFn({ method: "GET" })
  // `.validator`, not `.inputValidator`: the current docs name the newer method,
  // and @tanstack/react-start 1.169 has only this one (see docs/kit/spike-2026-10-evidence.md).
  .validator(greetInput)
  .handler(async ({ data }) => {
    const caller = { userId: null, role: "anonymous" }; // resolve from the session in a real binding
    return inSpan(
      workersTracer,
      "greet",
      { "app.capability": "greet", "app.caller.role": caller.role },
      async () => greet(caller, data),
    );
  });
