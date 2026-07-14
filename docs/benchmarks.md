# Reference benchmark protocol

No universal performance claims are made. Fill this record before v1.0.0 on a
named current Chrome and Edge WebGPU machine.

| Metric                                       | Supertonic 3 WebGPU |
| -------------------------------------------- | ------------------: |
| Cold model download                          |             pending |
| Cached initialization                        |             pending |
| First speech                                 |             pending |
| Real-time factor, 10 representative segments |             pending |
| Peak browser/GPU memory                      |             pending |
| Disposal/reload recovery                     |             pending |

Acceptance checks: cached controls under 100 ms, cached seek under 250 ms,
buffered transitions under 50 ms, no sustained main-thread inference/import
blocking, and successful recovery after model disposal and simulated GPU loss.

Record browser build, OS, CPU, GPU, memory, power mode, model revision, dtype,
text fixture, sample count, median, and p95. Preserve raw results with the release
artifacts.
