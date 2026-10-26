# Native ChatGPT quota reporting

## Finding

Checked on 2026-10-25 against the installed Pi 1.4.0 and current OpenAI documentation.
There is no verified supported numerical quota source for Pi's native `openai`
Sign in with ChatGPT connection. Do not present this as a broken login or require
OpenCode to use Belieb. Native inference works independently of quota reporting.

This is an upstream capability gap, not evidence that usage is unlimited, zero,
or calculable from the session's token totals or API-priced cost estimate.

## Verified evidence

A bounded live diagnostic using the existing native Pi OAuth grant made:

- `GET https://api.openai.com/v1/models`: HTTP 200, no quota-related headers.
  The catalog describes model capabilities/context windows, not subscription quota.
- One minimal streamed `POST https://api.openai.com/v1/responses`, with
  `store: false` and `stream: true`: HTTP 200 and `response.completed` received.
  No quota-related headers or quota field paths were found in the stream events,
  including `response.metadata` and `response.completed`.

Only sanitized diagnostic metadata was printed. No credentials, response text,
account identifiers, cookies or provider response bodies were recorded. The
native credential was not forwarded to ChatGPT backend endpoints. No OAuth login
or token refresh was performed for the diagnostic.

These checks do not prove that no undocumented route can ever exist. They do
establish that the documented native connection did not supply the requested
figures in this validation pass.

## Authentication boundary

Pi's native OAuth grant has scope `chatgpt.tokens.use.direct` and audience
`https://api.openai.com/v1`. Its OpenAI authentication metadata is opaque; do not
try to decrypt it or derive a ChatGPT account ID from it.

OpenAI documents model discovery and Responses inference for this flow and
explicitly says not to point the token at ChatGPT's `backend-api` endpoints.
The current UI guidance directs users to <https://chatgpt.com/settings/usage>.
A `subscription_sharing_usage_limit_exceeded` error does not establish which
plan/app window was exhausted or when it resets.

OpenCode's optional existing-login source uses a different saved OAuth grant.
It is a separately labeled workaround, not native Pi support. It remains off
unless explicitly enabled with `/belieb usage opencode` or `openCodeUsage: true`.
Use `/belieb usage pi` to disable it. The OpenCode preference was disabled in the
local user config after this investigation; native Pi inference was unchanged.

## References

- [OpenAI: models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI: token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [OpenAI: errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [OpenAI: UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [OpenAI Codex issue #54219: native token-sharing quota reporting](https://github.com/openai/codex/issues/54219)
  — checked open on 2026-10-25; the report describes the same missing numerical
  usage endpoint/headers/stream-event capability. This is a community report,
  not a promise from OpenAI to implement it.

## When to revisit

Revisit when OpenAI documents a native quota endpoint or quota response metadata,
or a third-party implementation supplies reproducible evidence using only the
native grant. Before enabling a new integration, verify:

1. The native grant is authorized for the exact origin, route and method.
2. The returned values distinguish shared plan limits from per-app limits.
3. Window durations, percentages and reset times are provider-reported and valid.
4. The current runtime login/endpoint matches the displayed account's data.
5. API-key, proxy, offline and headless paths cannot leak or substitute credentials.
6. Errors, account changes and expiry clear stale quota data without guessing.

Do not substitute browser cookies, a different application's login, organization
API billing, requests/tokens-per-minute limits or estimated consumption for native
subscription quota without the user's explicit, accurately labeled choice.
