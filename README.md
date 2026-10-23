# belieb

A real coding agent with a hand-drawn terminal avatar. An unofficial, independent
Bieber-inspired parody, powered by [Pi](https://github.com/earendil-works/pi).
Not affiliated with or endorsed by Justin Bieber, his representatives, or Pi.

Startup shows a ASCII wordmark and a Myspace-style profile card,
with restrained pink/purple accents and **beliebing…** while the agent works.
The model is a normal coding assistant; the parody is presentation only.

## Install from source

Requires **Node.js 22.19+** and npm. This initial release is not published to npm.
From a checkout of this repository:

```sh
npm ci --ignore-scripts
npm run build
npm link
cd /path/to/your/project
belieb
```

Or run `node /path/to/belieb/dist/cli.js` without linking.
For a portable npm artifact, run `npm pack`, then
`npm install -g --ignore-scripts /path/to/belieb-0.1.0.tgz`.

## Sign in and code

Start `belieb` in your project, then use `/login` to connect a supported
subscription or API key and `/model` to choose a model. Provider subscriptions
and billing are handled by the provider. You can also supply a provider's
standard environment variable (such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).
Never commit credentials.

```sh
belieb "Explain this repository"
belieb --continue
belieb --resume
belieb --model anthropic/claude-sonnet-4-5
belieb --print "Summarize this repository"
git diff | belieb --print "Review this diff"
belieb --mode json "List the project entry points"
belieb --mode rpc
```

Pi supplies the real read/bash/edit/write tools, streaming, auth, model picker,
session persistence, `/resume`, and cancellation. Press **Esc** to interrupt
an active run. Use `/quit` to exit. Tools can modify files and execute commands
with your user's permissions; work in a project you intend the agent to edit.

`belieb --help` is Pi's complete, unmodified help: substitute `belieb` for `pi`
in its examples. `belieb --version` reports the pinned **Pi runtime version
(1.4.0)**; this wrapper's version is **0.1.0**. All arguments are forwarded
without shell interpolation, including `--` and `@file` attachments.

## Settings and presentation

This deliberately shares Pi's standard `~/.pi/agent` credentials, settings,
extensions, and sessions, plus project `.pi` configuration. To isolate it:

```sh
PI_CODING_AGENT_DIR="$HOME/.belieb/agent" belieb
```

The bundled presentation extension is injected only when stdin and stdout are
terminals, and its UI changes run only in Pi's TUI mode. Print, piped, JSON,
and RPC output have no added banner, status messages, or styling. `--use-theme`
preserves your explicit theme; `NO_COLOR=1` disables this extension's coloring.
The palette retains Pi's semantic error, diff, and syntax colors. Pi's normal
footer, editor, shortcuts, and session controls remain available.

`--no-extensions` follows Pi's semantics: it disables discovered extensions,
but explicit extensions (including the terminal presentation) still load.
Package-management commands are forwarded unchanged. Update this wrapper's
pinned runtime through its dependency manifest, not `belieb update self`.

See the pinned [Pi documentation](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent/docs)
for provider support, configuration, RPC, tools, and sessions.

## Develop and verify

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

`src/cli.ts` loads Pi's shipped CLI in-process so Pi owns signals, terminal
cleanup, authentication, and execution. `src/args.ts` adds the TUI extension
without parsing or rewriting user arguments. `src/extension.ts` uses Pi's
typed extension API (`session_start`, `setHeader`, `setTheme`, and
`setWorkingMessage`). No fake model responses or extra agent orchestration.

Tests exercise argument fidelity, headless UI isolation, and real credential-free
CLI help, version, missing-auth failure, and RPC state. Paid model requests and
OAuth browser login require your own provider account and are not automated.
Dependencies are pinned with a committed lockfile. No package publication or
remote push is performed by the development scripts.

## Header art

The startup card uses a hand-drawn ASCII `BELIEB` wordmark with a pink-to-lilac
gradient and fake-terminal status lines (see `logo` in `src/extension.ts`). The
card collapses to a compact text header below 70 columns or under 28 terminal
rows, and `NO_COLOR` drops the gradient. No image library or network request.

Own code: MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for photo attribution
and the unofficial parody notice.
