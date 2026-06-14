---
name: codex-imagegen
description: Generate raster images through the Codex backend using the user's existing Codex/ChatGPT auth in ~/.codex/auth.json. Use when the user wants image generation without an OpenAI API key, or specifically wants to reuse Codex auth.
---

Use this skill when the user wants image generation via Codex's built-in backend path rather than the public OpenAI Images API.

The helper script lives at `scripts/image-gen.ts` relative to this skill.

## What it does

- Reads Codex auth from `~/.codex/auth.json`
- Calls `https://chatgpt.com/backend-api/codex/responses`
- Enables the built-in `image_generation` tool
- Saves generated images locally
- Renders them with kitty graphics protocol unless `--no-show` is passed

## Important limitation

Only `output_format` is directly exposed to the built-in tool. Flags like `--size`, `--quality`, `--background`, `--moderation`, and `--n` are passed as strong prompt instructions to the planner model, so they are best-effort rather than guaranteed backend parameters.

## Command

```bash
bun scripts/image-gen.ts --prompt "a brutalist sci-fi poster of Saturn"
```

## Common examples

```bash
bun scripts/image-gen.ts --prompt "a brutalist sci-fi poster of Saturn"

bun scripts/image-gen.ts \
  --prompt "a brutalist sci-fi poster of Saturn" \
  --size 1536x1024 \
  --quality high \
  --background auto \
  --output-format png

bun scripts/image-gen.ts --prompt "an isometric robot city at dusk" --n 4
```

## Workflow guidance

1. Prefer this skill only when the user explicitly wants to reuse Codex auth or avoid API-key setup.
2. Run the script from this skill directory or reference it by absolute path.
3. If the user wants to keep the output, report the saved file path(s).
4. If the script returns no `image_generation_call` items, show the backend output and explain that the built-in tool was not invoked.
5. If the user needs exact OpenAI Images API controls or guaranteed support for parameters like transparent background, use a normal API-key-based workflow instead.
