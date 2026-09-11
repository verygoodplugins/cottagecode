# Contributing

Thanks for poking at CottageCode.

## Before a large PR

Open an issue first when the change is bigger than a docs fix or a small bug.
That keeps the cottage feed contract from drifting without a conversation.

## Agent / project conventions

- [`AGENTS.md`](AGENTS.md) is canonical for coding agents.
- Product naming: CottageCode / Townmap / towns / cottages. See
  `.cursor/rules/naming.mdc`.
- Security reports go through GitHub Security Advisories
  ([`.github/SECURITY.md`](.github/SECURITY.md)), not public issues.

## Pull requests

1. Branch from `main`.
2. Prefer conventional commits (`feat:`, `fix:`, `docs:`).
3. PR titles should also be conventional (squash merges become the `main`
   commit title). Skip `[codex]` / `[wip]` prefixes in the title.
4. Smoke locally:

   ```bash
   npm start
   # http://127.0.0.1:8787/?demo=1
   curl -sS http://127.0.0.1:8787/agents | head
   ```

5. If the townmap UI changed, include a screenshot or note that demo mode still
   paints.

## Code of conduct

Be respectful. Prefer concrete repros over blame.
