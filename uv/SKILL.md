---
name: uv
description: Use when you plan to use the `uv` CLI for managing Python projects.
---

This is a living document of general uv guidelines.

Never use "uv pip..." or "uv run python...".
These can be replaced: instead of `uv pip install xyz`, just run `uv add xyz` (and ideally first use `uv init` and `uv venv`, then `source .venv/bin/activate`, to isolate your deps).
Instead of `uv run python xyz.py`, just run `uv run xyz.py`.
Similarly, instead of using `uv run python -m some_package`, you can simply do `uv run some_package`.

ALWAYS work in a venv, make sure you source the venv before doing anything else.
`uv` may occassionally surface a warning about working in nested venvs, in those cases, make sure to use `uv run --active` to use the inner venv.

For checking Python work, use the corresponding Astral tools: `uvx ruff check` for lint and `uvx ty check` for typecheck. Avoid using `python3 -m pycompile` or similar.