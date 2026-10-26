---
name: dumb-design
description: Use to generate minimal, functional UIs for throwaway projects, data visualization interfaces, etc., when the user doesn't care about UI quality.
---

# Dumb design

Immediately exit if I'm asking you to work or create something in a project that has its own style system. Making separated artifacts or reports etc. for a project doesn't count.

First, copy `assets/base.css` into the project and link it before any other CSS. It's basic styling that aligns with my preferences for raw HTML elements, with light/dark mode support and zero-specificity selectors. Of course, this means you need to use semantic HTML as much as possible.

Your own CSS should ideally be layout only, letting my CSS handle the styling as much as posible. For monochrome UI colors, you can use the variables from base.css.

Layout is everything. With a fixed design system, how you position things on the page is what makes the UX good or bad.

Use plain HTML and CSS, not Tailwind or React, unless the codebase uses them or the page is very interactive. Usually a `<script type="module" src="./index.ts"></script>` is enough (relative paths and TSX work). Put the HTML, `base.css`, and entry files in a project directory and serve it with `pnpm dlx vite /path/to/project`.
