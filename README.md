# ♥ belieb ♥

![belieb startup card: Braille portrait, BELIEB wordmark and a Myspace-style profile](assets/belieb-card.png)

```text
~*~*~ ♥ x3 ♥ LOL ~*~*~
Mood: beliebing
Now playing: the sound of your tests going green
Online Now! · Friends: 1 (it's you, and Pi is your Top 1)
```

omg hi!!! ♥ ok so u know how everyone is like "u NEED an AI coding agent" and
ur like "but where is the swoop"?? well NOW there is **belieb**: a *real* coding
agent with a hand-drawn terminal avatar, a Myspace profile card, and exactly
the right amount of pink + purple. ily. 💜

---

## ~ about me ~

**belieb** wraps Pi's real coding agent (read / bash / edit / write tools,
streaming, auth, model picker, sessions, cancellation) and swaps out the look:

- an ASCII `BELIEB` wordmark + Myspace-style profile card at startup
- a pink-to-lilac gradient (drops away with `NO_COLOR=1`)
- a footer that stays visible while you work
- **beliebing…** whenever the model is thinking

Everything cosmetic only happens in the interactive terminal UI. Print, piped,
JSON and RPC output get no banner, no status messages, no styling. Promise!!

## ~ who i'd like to meet ~ (install)

Needs **Node.js 22.19+** and npm. This first release is **not on npm yet**, so
grab it from source:

```sh
npm ci --ignore-scripts
npm run build
npm link
cd /path/to/your/project
belieb
```

No linking? No prob: `node /path/to/belieb/dist/cli.js`.
Want a portable file? `npm pack`, then
`npm install -g --ignore-scripts /path/to/belieb-0.3.0.tgz`.

## ~ first dance ~ (sign in and code)

Start `belieb` in your project, then:

1. `/login` to connect a subscription or API key
2. `/model` to pick a model
3. type something. that's it!!

You can also use your provider's usual env var (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, ...). Subscriptions and billing are handled by the provider.
**Never commit credentials.** (Never say never to everything else tho.)

```sh
belieb "Explain this repository"
belieb --continue
belieb --resume
belieb --model anthropic/claude-sonnet-4-5
belieb --plan "Find why the auth tests flake"
belieb --print "Summarize this repository"
git diff | belieb --print "Review this diff"
belieb --mode json "List the project entry points"
belieb --mode rpc
```

Press **Esc** to interrupt a run. `/quit` to exit.

**Heads up, bestie:** tools can modify files and run commands with *your user's
permissions*. Only point belieb at projects you want it to edit.

Using DeepSeek? `/login deepseek`, paste your key, then `/model` and pick
`DeepSeek V4.1 Flash` (`deepseek/deepseek-flash`) or `DeepSeek V4 Pro`
(`deepseek/deepseek-v4-pro`), or just set `DEEPSEEK_API_KEY`. Keys are stored in
the shared `~/.pi/agent/auth.json`.

`belieb --help` is Pi's complete, unmodified help: just read `pi` as `belieb`.
`belieb --version` reports the pinned **Pi runtime (1.4.0)**; this wrapper is
**0.3.0**. All arguments are forwarded without shell interpolation, including
`--` and `@file` attachments.

## ~ my top friend ~ (Pi settings, shared!)

belieb shares Pi's standard `~/.pi/agent` credentials, settings, extensions and
sessions, plus project `.pi` config. Want your own space? Make a private profile:

```sh
PI_CODING_AGENT_DIR="$HOME/.belieb/agent" belieb
```

Details for the nerds ♥

- The presentation extension always loads, so `--plan` and the prompt templates
  work in `--print`, JSON, RPC and piped runs too.
- `--use-theme` keeps *your* theme. `NO_COLOR=1` keeps the layout, drops the color.
- Pi's semantic error, diff and syntax colors are kept.
- Editor, shortcuts, transcript and session controls are unchanged. belieb only
  replaces the header, footer, title, working indicator and accent palette.
- `--no-extensions` follows Pi: it disables *discovered* extensions, but the
  presentation extension is explicit, so it still loads.
- Package-management commands are forwarded unchanged. Bump the pinned runtime
  through the dependency manifest, not `belieb update self`.

## ~ my besties ~ (MCP servers)

MCP just works, because it's Pi's built-in support (stdio + streamable HTTP, OAuth):

```sh
belieb mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
belieb mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
belieb mcp list
```

Servers live in `~/.pi/agent/mcp.json` (or `.pi/mcp.json` in a trusted project) in
the same format as Claude Code and Cursor. Inside belieb, `/mcp` is Pi's manager
(connect, sign in, exposure, enable/disable) and `/reload` picks up edits.

**Who's online?** Connected servers show in the footer as `mcp 2`, and
`/belieb mcp` lists each one with its tool count. `/belieb stats` has the names too.
A server that failed to connect (or has zero tools) isn't listed; `/mcp` shows why.
`--no-mcp` turns it all off for one run. More in the
[Pi MCP docs](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md).

## ~ beliebers ~ (subagents)

Beliebers use one model you choose, as **workers** or **reviewers**. Cheaper workers
produce implementations directly in files; the main model specifies requirements,
reviews changes and runs verification. No separate agent definition files needed.

```text
/beliebers model deepseek/deepseek-flash
/beliebers parallel 2
/beliebers access write
```

The last command asks for confirmation and persists permission for scoped file
workers. Access defaults to **read** for new and existing configurations;
`/beliebers access read` returns future delegations to reviewers only. The tool
cannot change the model or access. Until you choose a model, Beliebers are off;
`/beliebers off` disables them again. After rebuilding, restart Belieb or reload
its extension to load the new schema and main-agent delegation instructions.

Ask normally: **"Delegate implementation to workers; review their changes and run
the tests yourself."** The main agent checks `action: "list"`, assigns each worker
its own files, then reviews the actual changes instead of regenerating their code.
A string task is a legacy read-only reviewer; object tasks select the capability:

```json
{"action":"run","tasks":[
  {"task":"Implement the parser; preserve its public API.","mode":"worker","files":["src/parser.ts"]},
  {"task":"Review edge cases in src/format.ts.","mode":"reviewer"}
]}
```

- Each task runs in a separate, non-persistent Pi process and context. The main
  agent supplies the task context; your whole conversation is not copied.
- Workers get `read`, `grep`, `find`, `ls`, **`edit` and `write`**. Reviewers get
  only reading tools, even with write access enabled. Workers write directly and
  return short summaries, not complete code for the main model to reproduce.
- Each worker lists **1–64 exact workspace-relative files**, including new files.
  Parallel ownership must not overlap (conservatively including case variants and
  file/descendant conflicts). Directory/glob grants, traversal, symlinks (including
  in-tree aliases), hardlinks, `.git`, `.pi`, `.belieb` and `node_modules` are refused.
  Every edit/write is checked again by the child guard. Use forward-slash paths.
- **No bash, MCP, discovered extensions, skills or nested subagents.** The main
  agent still runs commands/tests and Blender/MCP; workers can author the scripts.
- Plan mode forces reviewers **at delegation time**, even with write access.
  Access/plan changes do not retroactively revoke an active batch: cancel it first.
- **Not an OS sandbox:** reads can access your user-accessible files, and external
  filesystem races are not prevented. Review changes before executing them. The
  main `/undo` does **not** capture child writes. Cancellation/failure can leave
  partial changes; use backups/version control and inspect all assigned files,
  including untracked/new files. Do not edit worker-owned files concurrently.
- Default parallelism is **2**, configurable from **1–4**, with up to **8 tasks**
  per call. Esc cancels running children and skips queued tasks; session shutdown
  waits for child cleanup. Each child has a five-minute time limit.
- The tool shows live task status; expand it for reports and per-task spend.
  Child usage contributes to session cost and `/cost`. Reports are capped at
  32 KiB per task; truncation is explicit.
- Models use the existing Pi credentials/environment and `models.json`.
  Extension-defined providers are not loaded in children. Missing credentials,
  unavailable models and model mismatches fail explicitly—no silent fallback.
  The `/beliebers model` list scrolls inside the picker, so long catalogs never
  push the cursor past the bottom of the screen.
- Beliebers also work in print, JSON and RPC runs, without terminal decoration.
  Set their model interactively first or in the config below.

## ~ the footer ~ (status bar, but make it a song)

```text
♥ belieb · claude-sonnet-4-5 · main · ctx 42% · $0.42 · mcp 2 · tests ✓ · ♪ working
```

First comes the mode: `♥ belieb` for normal coding, `⏸ plan` while planning.
On narrow terminals segments drop from least to most important: session cost,
then context usage, then branch, then model.

What it says while it works:

| Doing | belieb says |
| --- | --- |
| reading | learning the choreography… |
| editing | recording vocals… |
| tests and commands | soundcheck… |
| git | boarding the tour bus… |
| thinking | beliebing… |

About 1 thinking phase in 100, it says `Freemasons run the country...` instead.
Rare flash, not a whole-run theme. `BELIEB_RARE=always` or `BELIEB_RARE=never`
to force or kill it.

After a test, lint or build command the footer adds a badge like `tests ✓`,
`lint ✗` or `build ✓`. Each kind keeps its own state (`tests ✗ · lint ✓`), and
other extensions' `setStatus()` text stays visible.

### Native ChatGPT quota availability

Pi's native `openai` login works for inference, but currently has no verified
supported source for 5-hour/weekly remaining quota or reset times. A live native
model-list/inference check returned no quota headers or stream fields; the same
gap is tracked in [OpenAI Codex #54219](https://github.com/openai/codex/issues/54219).
`pi-usage`'s `chatgpt usage: web only` means those figures must currently be checked
at [ChatGPT usage settings](https://chatgpt.com/settings/usage), not that your Pi
login is broken. No OpenCode login is required to use Belieb.
See [the investigation and evidence](docs/chatgpt-usage.md) before adding a new
native integration or assuming a different app's credentials are necessary.

### Optional workaround: ChatGPT limits from an existing OpenCode login

For native Pi `openai` models, you can opt into read-only quota checks using your
existing OpenCode login—no extra Pi/Codex login or inference-provider change:

```text
/belieb usage opencode
```

The footer shows `OpenCode 5h 72% left · week 41% left` (actual returned values).
**These are the OpenCode login's plan limits**, which may belong to a different
ChatGPT account/workspace from Pi. Choose the intended account in OpenCode first;
Belieb cannot prove the two logins belong to the same account.

- Off by default; `/belieb usage pi` disables it and stops reading OpenCode auth.
- Reads `~/.local/share/opencode/auth.json`, respecting `XDG_DATA_HOME`, with an
  additional `%APPDATA%/opencode/auth.json` fallback on Windows. Only the saved
  OpenAI OAuth bearer and matching account ID are used, in memory.
- Never copies, refreshes, writes or logs credentials. If the login is expired,
  reconnect OpenAI **in OpenCode**; the next poll picks up the updated file.
- Only read-only GETs to the fixed `https://chatgpt.com/backend-api/wham/usage`
  endpoint; redirects are rejected. This endpoint is undocumented and can change.
- Polls once per minute while a native OpenAI OAuth model is selected in the TUI.
  No OpenCode reads in headless, offline, plain, API-key or other-provider modes.
- Missing/expired/invalid credentials and request errors clear old percentages;
  they never fall back to sending Pi's native token to ChatGPT.
- Suppresses `pi-usage`'s native `chatgpt …` status while this source is selected,
  avoiding a contradictory `web only` label. `/usage` itself remains owned by
  `pi-usage`; this setting changes only Belieb's footer.

## ~ market ~ (browse and install)

`/market` browses two official catalogs from inside belieb:

| Source | Catalog | Installs with |
| --- | --- | --- |
| Pi packages | npm packages tagged `pi-package` — the same set as [pi.dev/packages](https://pi.dev/packages) | `pi install npm:<name>@<version>` |
| MCP servers | the [official MCP registry](https://registry.modelcontextprotocol.io) | `pi mcp add <name> …` |

```text
/market                     # pick a source, then browse or type to search
/market pi usage            # Pi packages matching "usage"
/market mcp github          # MCP servers matching "github"
/market pi usage --local    # write to project settings instead of user settings
```

The picker opens on the catalog, so browsing needs no query: Pi packages are
sorted by monthly npm downloads, busiest first, and each row shows that number
(`1.8M/mo`). The MCP registry publishes no download counts or popularity order,
so its first page is listed A–Z and the status line says so.

Type in the box and results follow as you go: a keystroke burst costs one
debounced request, older answers are discarded when a newer query lands, and the
previous list stays visible while the next one is in flight. **enter** opens the
detail and install confirmation, **esc** clears the query first and cancels on the
second press. Nothing installs until you confirm a screen that shows the published
name, the pinned version, the exact `pi` command, and the source link. After a
successful install belieb says so and you run `/reload`.

**Guarantees**

- Third-party code runs with your user permissions, so installs are always one
  explicit confirmation, never a side effect of searching. There is no "verified"
  badge: the `pi-package` keyword is self-published and typosquatting is possible.
- The confirm screen shows the exact command. Versions are pinned; nothing floats
  to `latest` later.
- Only fixed endpoints (`registry.npmjs.org`, `registry.modelcontextprotocol.io`)
  are queried, with redirects rejected, responses capped at 1 MB, and no
  credentials sent. Browsing the Pi catalog costs one request for an npm page of
  250 packages; only the 100 most downloaded are listed.
- The `pi` subprocess gets an argument array, no shell and no stdin, so a listing
  cannot inject a second command or answer a prompt for you.
- User scope by default; `--local` is the only way to touch project settings.
- MCP servers are listed when browsable but **not** auto-installed if they need
  secrets, a non-HTTPS endpoint, an unsupported package type, or a local name that
  already exists. The reason is shown instead.
- Nothing is fetched in `--offline`, print, JSON or RPC-without-dialog runs.

Browsing only, for now: no uninstall, update or ratings UI. `/market` is the
browse-and-add surface; Pi's own `pi list`, `pi remove`, `pi update --extensions`
and `pi mcp remove` still own the rest.

## ~ modes ~ (plan vs belieb)

`/mode` opens a picker:

- `⏸ plan`: "You're the next chart hit — read-only."
- `♥ belieb`: "Never say never — full tools and edits."

Toggle directly with `/plan`, `Ctrl+Alt+P`, or `--plan` at startup. In plan mode
edit and write are disabled, bash is limited to read-only commands, and the agent
gives you a numbered plan instead of changes. `2>&1` and `2>/dev/null` still
count as read-only. `curl` is allowed unless it can write or mutate (`-o`, `-O`,
`-T`, `-X`, `-d`, `-F`). Return with `/plan`, `/mode`, or `/belieb belieb`.

This guards Pi's built-in tools. It's a workflow mode, **not an OS sandbox**:
`env` or `cat .env` can still show secrets to the model.

## ~ undo, redo, cost ~ (oops i did it again)

- **`/undo`** reverts the whole previous turn: files changed via `edit`/`write`
  are restored, files it created are removed.
- **`/redo`** replays the turn you just undid. New agent work clears the redo chain.
- Snapshots are session-local and capped: 30 turns, 8 MB total, 512 KB per file.
  **Changes made through bash or Belieber child processes are not covered.**
- **`/cost`** shows total cost, tokens in/out, cache reads/writes and context
  usage (same numbers as `/belieb stats`), following Pi's own bookkeeping.

**Finish notifications** are opt-in: `/belieb notify on` (or `BELIEB_NOTIFY=1`)
sends an OSC 9 desktop notification and sets the tab title to `♥ belieb · done`
for runs of 20s or more (`cancelled` if aborted). `/belieb notify off` to stop.

## ~ commands ~

| Command | Effect |
| --- | --- |
| `/beliebers` | Choose the shared subagent model, parallelism and access |
| `/beliebers model <provider/id>` | Set the Beliebers model (no silent fallback) |
| `/beliebers parallel <1-4>` / `off` | Limit parallel tasks / disable Beliebers |
| `/beliebers access read` / `write` | Reviewers only / enable scoped file workers (confirmed) |
| `/mode` | Pick plan or belieb from a panel |
| `/undo` | Revert every file change from the last turn |
| `/redo` | Re-apply the change reverted by `/undo` |
| `/cost` | Session spend, tokens and context usage |
| `/belieb notify on` / `off` | Finish notifications for long runs |
| `/belieb usage opencode` / `pi` | Opt into existing OpenCode login for ChatGPT footer limits / disable |
| `/market` | Browse and install Pi packages and MCP servers |
| `/belieb mood <name>` | Switch palette: `purpose` (default), `changes`, `justice`, `peaches`, `myworld` |
| `/belieb mood` | Pick a mood interactively |
| `/belieb plan` / `/belieb belieb` | Enter plan mode / return to normal coding |
| `/belieb off` / `/belieb on` | Plain mode: remove theme, header, footer and decoration |
| `/belieb mcp` | List connected MCP servers and their tool counts |
| `/belieb card` | Print the profile card in the transcript |
| `/belieb stats` | Tour stats: mode, model, context, tokens, cost, turns, tools, files, undo, branch |
| `/belieb credits` | Photo, Pi and license attribution |

Pi tags `/` menu commands by source: `[u]` user, `[p]` project, `[t]`
temporary/command-line. belieb's extension and prompts ship with the wrapper, so
they show as `[t]`. A hint like `[focus]` means an optional argument
(`/soundcheck security`); a counter like `(31/46)` is your position in the list,
not a filter. The profile card is a custom session entry: it shows in the
transcript but is never sent to the model.

### Prompt templates (the setlist)

| Command | What it does |
| --- | --- |
| `/soundcheck` | Review the diff |
| `/purpose` | Plan first |
| `/sorry` | Fix red tests |
| `/encore` | Recap and next steps |
| `/setlist` | Draft a commit message |

They're plain templates discovered through the extension, so nothing gets written
to `~/.pi`. `--no-prompt-templates` turns them off.

## ~ my settings ~ (config)

Preferences live in `~/.belieb/config.json` (`BELIEB_DIR` changes the directory):

```json
{
  "mood": "purpose",
  "plain": false,
  "notify": false,
  "openCodeUsage": false,
  "beliebers": { "model": null, "parallelism": 2, "access": "read" }
}
```

- `BELIEB_PLAIN=1` forces plain mode for one run without touching the file.
- `BELIEB_NOTIFY=1` / `0` overrides the saved notification preference.
- With `--use-theme`, a mood is saved but not applied (you asked for your own palette).

More on providers, RPC, tools and sessions in the pinned
[Pi docs](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent/docs).

## ~ behind the scenes ~ (develop and verify)

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

How it's wired:

- `src/cli.ts` loads Pi's shipped CLI in-process, so Pi owns signals, terminal
  cleanup, auth and execution.
- `src/args.ts` adds the presentation extension without parsing your arguments.
  It only turns the boolean `--plan` into `--plan=true`, because Pi's extension
  flag pre-pass would otherwise swallow the prompt after it.
- `src/extension.ts` hooks Pi's typed extension API (`session_start`,
  `turn_start`, `tool_execution_start`, `agent_settled`, entry renderers,
  `/belieb`, `/undo`, `/redo`, `/cost`).
- `src/branding.ts`: theme, header, footer, title, working indicator, badges.
- `src/subscription-usage.ts`, `opencode-usage.ts`: quota polling and the optional,
  read-only OpenCode credential source.
- `src/market.ts`, `market-install.ts`, `market-browser.ts`, `market-command.ts`:
  the npm `pi-package` and MCP registry clients, safe `pi` argument construction
  and process runs, the live-search `/market` browser with its confirmation screen.
- `src/card.ts`: the Myspace card and panels.
- `src/palettes.ts`, `config.ts`, `plan.ts`, `checkpoints.ts`, `usage.ts`,
  `checks.ts`, `notify.ts`, `commands.ts`: moods, preferences, plan mode,
  undo/redo, cost, check badges, notifications, command handlers.
- `src/beliebers.ts`, `model-picker.ts`, `belieber-runner.ts`, `belieber-guard.ts`,
  `belieber-policy.ts`: shared subagent settings, scrolling model picker,
  worker/reviewer delegation, bounded children, exact-model checks, file ownership
  and per-call mutation authorization.

Tests cover argument fidelity, headless UI isolation, footer and working-state
behavior, plan-mode tool restrictions (descriptor redirects, curl write flags),
the mode picker, the scrolling Beliebers model picker, undo/redo, cost accounting,
check badges, notifications, mood
persistence, bundled prompt discovery, and real credential-free CLI help,
version, missing-auth failure, headless `--plan` and RPC state. Beliebers tests
cover config migration, model selection, bounded concurrency, cancellation,
shutdown, timeouts, read-only and worker loadouts, confirmed access, path scoping,
usage, output limits and delegation through the real Pi CLI against a local mock
provider, including actual assigned-file edits and blocked out-of-scope writes. Marketplace tests cover registry
parsing and keyword filtering, download-ranked browsing, debounced live search,
stale-response rejection, name/version/URL validation, blocked listings,
argument construction, shell-free process runs, cancellation without install, and
headless/offline refusal using recorded fixtures rather than the network. Paid model
requests and OAuth browser login need your own provider account and are not
automated. Dependencies are pinned with a committed lockfile. Nothing here
publishes a package or pushes to a remote.

## ~ pics ~ (header art)

The startup card pairs a 40 x 20 Braille portrait (dithered from a CC BY 2.0
photo, see [NOTICE](NOTICE); `src/portrait.ts`) with a hand-drawn ASCII `BELIEB`
wordmark, a pink-to-lilac gradient and fake-terminal status lines (see `logo` in
`src/card.ts`). Below 70 columns or 28 rows it collapses to a compact text
header. The gradient is memoized so streaming re-renders stay cheap.

## ~ credits & legal ~

Own code: MIT, see [LICENSE](LICENSE). The terminal portrait is adapted from a
CC BY 2.0 photo by Kevin Aranibar of Kerosene Photography; full attribution and
change history are in [NOTICE](NOTICE). belieb is an independent project, not
affiliated with Justin Bieber or with Pi's maintainers. Names belong to their
respective owners.

---

*thx for stopping by my page!! leave a comment, add me, and never say never to
shipping.* ♥ 💜 ♥

`~*~ xoxo ~*~`
