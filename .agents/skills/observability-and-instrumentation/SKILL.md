---
name: observability-and-instrumentation
description: Instruments code so production behavior is visible and diagnosable. Use when adding logging, metrics, tracing, or alerting. Use when shipping any feature that runs in production and you need evidence it works. Use when production issues are reported but you can't tell what happened from the available data.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/observability-and-instrumentation/SKILL.md
---

# Observability and Instrumentation

Follow [the upstream skill](../../3rdparty/agent-skills/skills/observability-and-instrumentation/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- OpenTelemetry from the first commit, with span attributes only from the
  registered keys, and no secrets, PII or bodies (`docs/kit/observability.md`;
  the `telemetry` recipe).
