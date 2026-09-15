---
name: linear
description: Use when the user asks to read, create, or update Linear issues, or otherwise interact with Linear
---

CLI: `~/.agents/skills/linear/linear.ts` (runs via `pnpm dlx tsx`). Add `--json` to any command for structured output.

Auth: `.env` next to the script with `LINEAR_API_KEY=lin_api_...`. If missing, tell the user to create one at Linear > Settings > Security & access > Personal API keys.

```bash
L=~/.agents/skills/linear/linear.ts

$L me                                   # who am I + teams (auth check)

$L issues                               # my open issues
$L issues --team ENG --state "In Progress"
$L issues --assignee alice --project "Q3 launch"
$L issues --search "login bug" --all    # --all includes done/canceled
$L issues --mine --team ENG --limit 50

$L issue ENG-123                        # description, sub-issues, comments

$L create --team ENG --title "Fix login" --description "..." --assignee me \
  --state Todo --priority 2 --label bug,frontend --project "Q3 launch" --parent ENG-100

$L update ENG-123 --state Done
$L update ENG-123 --assignee alice --priority 1 --label bug --title "..."

$L comment ENG-123 "Fixed in abc123"

$L meta --team ENG                      # states, labels, members, projects (names + ids)

$L gql '{ cycles(first: 3) { nodes { name startsAt endsAt } } }'
$L gql 'query($id: String!) { issue(id: $id) { history { nodes { createdAt toState { name } } } } }' \
  --vars '{"id":"ENG-123"}'
```

Notes:
- `issues` with no `--team/--assignee/--project/--search` defaults to mine. Non-done only unless `--all` or `--state`.
- States, labels, projects, and members are matched by name (case-insensitive). `--assignee me` works. Priority: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
- Anything not covered (projects, cycles, initiatives, bulk ops): use `gql`. Schema is introspectable; https://linear.app/developers/graphql.
