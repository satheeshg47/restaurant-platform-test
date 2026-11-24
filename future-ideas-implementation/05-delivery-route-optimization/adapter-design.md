# Delivery route optimization — adapter design

VROOM was identified as a candidate reference engine for vehicle routing. It is not part of the core platform and should not become a required dependency.

## Adapter boundary
Define a provider-neutral interface:
- Input: delivery jobs, pickup/depot, time windows, service durations, vehicle capacity and constraints.
- Output: ordered stops, assigned vehicle, estimated distance/duration and unassigned jobs with reasons.
- Errors: invalid input, no feasible route, timeout, provider unavailable.

## Safety and cost
- Keep manual dispatch available at all times.
- Do not require a paid geocoding or maps provider; coordinates may be entered or supplied by a separately approved provider.
- Minimize customer address exposure; send only what the optimizer needs.
- Set strict timeouts and payload limits.
- Treat route output as a suggestion; dispatcher confirms.
- Review VROOM's current licence and deployment requirements before use. This folder contains no copied VROOM source.
