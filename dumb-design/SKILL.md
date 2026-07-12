---
name: dumb-design
description: Use to generate minimal, functional UIs for throwaway projects, data visualization interfaces, etc., when the user doesn't care about UI quality. Ask the user if you're not sure whether to use this skill or the frontend-design skill.
---

# Dumb design guidelines

1. Avoid bringing in new fonts. This is a recipe for design disaster. Use `sans-serif` or `-apple-system`, or in the case when it makes sense to use serif, `serif` or `Charter, serif`. If the user explicitly requests a font, you can use it, but otherwise, stick to these basic system fonts.
2. Keep the design refreshingly minimal. Use browser layout defaults as much as possible. Think 2000s-era Google SSO page. You probably don't need unnecessary cards or background colors or fancy buttons or borders; you probably just need a <table> and a few decently minimally styled flat <button>s.
3. Take advantage of HTML and CSS; don't use Tailwind unless the codebase prescribes it. Use React etc. if the codebase prescribes it or if the site is sufficiently interactive. In most cases, you should be able to get away with a `<script type="module" src="./index.ts"></script>` or similar (relative paths work, as do TSX files). Put the HTML and its entry files in a project directory, then run `pnpm dlx vite /path/to/project` to serve the page and handle TypeScript(X) compilation and bundling.
4. In dumb design, layout is everything. Even if you're using the most boring fonts and the most boring design system, how you position elements on the page makes a huge difference in UX. 
