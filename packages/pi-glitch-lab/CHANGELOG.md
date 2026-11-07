# pi-glitch-lab changelog

## 0.5.0

- First independent `@stacknyu/pi-glitch-lab` npm release, with Pi-native manifest, host peers, release notes and MIT license.
- Extend the rendered-control scan with bounded state exploration, scrolling, observable outcomes, before/after evidence and honest coverage/limit reports.
- Add deterministic UAT assertions for URL, visibility, values, checked/enabled state, counts and attributes, including reload/persistence journeys.
- Require explicit interaction/write authorization; enforce origin/request guards, strict targets and positive login verification. Keep browser auth in memory rather than checkout files.
- Reject evidence/baseline overwrites and propagate failed/incomplete runs as tool errors; prevent stale results from appearing successful.
- Correct cross-document sensor timing, React root traversal, text-flap timing and DOM evidence frames. Report sampling limitations rather than claiming exhaustive frame coverage.
- Add synthetic browser, failure, sensor and standalone-package regressions. No production targets, credentials or model calls are used by the tests.
