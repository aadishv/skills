---
name: hardware
description: Reference for this laptop’s hardware so agents can make better performance and tooling decisions.
---

This machine is a 14-inch Apple Silicon MacBook Pro with the base M5 Pro, 24GB unified memory, and 1TB SSD.

## Hardware

- Apple M5 Pro
- 15-core CPU: 5 super cores, 10 performance cores
- 16-core GPU
- 16-core Neural Engine (ANE)
- 307GB/s memory bandwidth
- 24GB unified memory
- 1TB SSD

Apple references:
- https://support.apple.com/en-us/126318
- https://www.apple.com/macbook-pro/specs/
- https://www.apple.com/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/

## M5-specific note

The important M5 change is the GPU-side Neural Accelerators. These are distinct from the 16-core ANE.

- GPU Neural Accelerators: one in each GPU core; meant for GPU-based AI workloads
- ANE: separate dedicated accelerator block; not the same hardware

Apple says Core ML, Metal Performance Shaders, and Metal 4 can benefit automatically, and Metal 4 tensor / ML APIs can target this path more directly.

## Practical guidance

For large local ML workloads on this machine:
- Prefer MLX over NumPy/JAX/PyTorch defaults when possible
- Prefer `mlx-lm` for local LLM inference
- Prefer quantized MLX models for larger models
- Keep hot paths inside one framework; avoid bouncing tensors between MLX / NumPy / PyTorch
- Use Core ML for app-style inference/deployment
- Use Metal / MPSGraph only when lower-level control is needed

## Performance expectations

Early third-party coverage suggests:
- CPU: roughly ~10–12% single-core uplift vs M4-class chips
- CPU: roughly ~20% multicore uplift vs M4 Pro
- GPU: roughly ~20–30% uplift vs M4 Pro in many tests
- AI benchmarks likely understate gains because tooling may not fully exploit the new GPU Neural Accelerators yet
