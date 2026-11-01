# ask-form

A Copilot extension that lets the agent ask several related, typed questions in **one form**.
The explanation the questions depend on is shown **inside** that form.

## Status

The extension is built and covered by stub-host tests. It has **not been validated in the live
GitHub Copilot app**, so read [Known limitations](#known-limitations) before relying on it.

## Why

In the Copilot app, the built-in `ask_user` tool has three problems:

- **One question per prompt.** It takes `{question, choices}`, and its own guidance says to ask
  one question at a time.
- **Text choices only.** There are no booleans, numbers, multi-select, or dates.
- **Missing context.** Chat text written just before the question is not always visible while the
  question is open (github/app#4957, #4458). The text is still in the event log, so this is a
  display problem, not lost model context.

The agent runtime already renders multi-field typed forms through `session.ui.elicitation`. The
`clip` extension's picker uses them in the app. `ask-form` exposes those forms to the agent as a
tool and makes the explanation part of the form itself.

## Commands and tools

There are no slash commands. The extension adds one tool, `ask_form`, which is always loaded
(`defer: "never"`).

| Argument | Required | Meaning |
| --- | --- | --- |
| `context` | yes | Markdown shown at the top of the form, up to 20,000 characters. It holds everything the user needs to answer. |
| `questions` | yes | 1–10 questions, described below. |
| `allowComment` | no | Adds an optional "Anything else?" free-text field. Defaults to `true`. |

Each question has:

- an `id`: letters, digits and underscores, starting with a letter
- a `question`: at most 300 characters
- a `type`, plus the optional fields that type allows:

| `type` | Form field | Options |
| --- | --- | --- |
| `choice` | pick one | `options` (2–25), `allowOther` |
| `multi_choice` | pick several | `options`, `minItems`, `maxItems`, `allowOther` |
| `boolean` | yes / no | |
| `text` | free text | `minLength`, `maxLength` (≤ 5000) |
| `number`, `integer` | number | `min`, `max` |
| `email`, `url`, `date`, `datetime` | formatted string | |

Every question type also accepts:

- `default`: a pre-filled answer, such as a recommended option. It is validated against the type
  and options.
- `description`: help text shown under the field.
- `required`: defaults to `false`. Blank answers are reported back as `unanswered`.

Any other key on a question is rejected with an error that lists the allowed keys, so a typo
such as `minimum` for `min` cannot silently drop a constraint.

An elicitation field cannot combine a list with free text, so `allowOther` adds a separate
`<id>__other` text field.

### What the agent gets back

| Outcome | `resultType` | Content |
| --- | --- | --- |
| The user submitted the form | `success` | JSON with `answers`, plus `unanswered`, `invalid` and `comment` when present. |
| The user declined | `success` | States that the user declined and that this is **not** approval. |
| The user dismissed the form, or the host reported no action | `success` | States that the form was dismissed and that this is **not** approval. |
| The wait timed out | `timeout` | States that a late answer will not reach the agent. |
| The host aborted the tool call | `failure` | States that the user did not answer. |
| The request was invalid | `failure` | A list of fixes. Nothing was shown to the user. |
| The host has no elicitation support | `failure` | Tells the agent to use `ask_user` with the context in the question. |
| The call came from a sub-agent | `rejected` | Only the main agent may ask. |
| Another form is still open | `failure` | Only one form at a time. |

Answers are never invented:

- A missing answer is reported as `unanswered`.
- A value with an unexpected shape is reported under `invalid` with its raw value, so the agent can
  confirm it with the user.
- A boolean answered as the string `"true"` or `"false"`, or a number answered as a numeric string,
  is accepted. The host's own structured `ask_user` notes that booleans can arrive that way.

### Not a consent mechanism

`ask_form` only asks questions. It never replaces tool-permission prompts, sign-in or
authentication prompts, or approval steps, and an answer here does not grant any of them. The
extension does not:

- override the built-in `ask_user`
- set `askUserVariant` or `onElicitationRequest`
- answer pending requests that belong to anything else

## Install

Ask Copilot to install it directly from the repository once it is published, or place the folder
yourself and run `/extensions reload`:

| Platform | Destination |
| -------- | ----------- |
| Windows  | `%USERPROFILE%\.copilot\extensions\ask-form\` |
| macOS / Linux | `~/.copilot/extensions/ask-form/` |

The files required at runtime are `extension.mjs` and `form.mjs`. Install from an immutable
snapshot of a commit rather than the working tree:

```powershell
$sha = git -C C:\path\to\ask-form rev-parse HEAD
$dest = "$env:USERPROFILE\.copilot\extension-releases\ask-form\$sha"
git -C C:\path\to\ask-form archive --format=zip -o "$dest.zip" $sha
Expand-Archive "$dest.zip" $dest; Remove-Item "$dest.zip"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.copilot\extensions\ask-form" -Target $dest
```

## Configuration

The first file found wins: `$COPILOT_ASK_FORM_CONFIG`, then `~/.copilot/ask-form.json`, then the
built-in defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `timeoutMs` | `1500000` (25 min) | How long a form waits before the tool reports a timeout. Values are capped at 1,790,000 ms, just below the host's tool limit. |
| `debugLog` | `~/.copilot/logs/ask-form.log` | Trace file. Set to `null` to disable. It records outcomes, counts and timings, never answer content. |

## Researched host constraints

These are observations from the runtime source and from earlier sessions, not guarantees.

- **No in-dialog cancel.** `session.ui.elicitation` takes no abort signal. When the wait ends, the
  tool returns, but the dialog can stay on screen. Answering it then does nothing: the late answer
  is logged as ignored and never reaches the agent.
- **1800-second tool limit.** The host aborted a tool call that was waiting on a dialog after
  exactly 1800 s (self-learn, session 8282634f). `ask_form` ends its own wait first, so the agent
  gets an explicit timeout result rather than an unexplained abort.
- **Lost on restart.** `elicitation.requested` and `elicitation.completed` are `ephemeral` session
  events. A form that is open when the app or session restarts is not restored. The tool call ends,
  and the agent must ask again.
- **Stuck after the turn ends.** An elicitation resolved after `assistant.turn_end` has left the app
  showing "running" (self-learn `extension.mjs`). While `ask_form` is waiting, the turn has not
  ended. A form answered *after* a timeout, however, may trigger the same stuck state.
- **Competition with the built-in `ask_user` guidance.** The host injects instructions to use
  `ask_user` and to ask one question at a time. The tool description of `ask_form` steers the agent
  toward this tool for multi-question or context-heavy asks, but it cannot remove that guidance.
  How often each model picks `ask_form` is unmeasured.
- **Static forms.** One answer cannot show or hide another field. Ask follow-up rounds instead.
- **Autopilot.** The runtime changelog says autopilot auto-handles elicitations. What
  `session.ui.elicitation` returns in autopilot is unverified. The tool reports exactly what the
  host returned and never adds consent.
- **Rendering.** It is unverified whether the app renders markdown in the form message, including
  tables and code blocks, and whether long context scrolls.

### Possible follow-up routes (not used here)

The shipped SDK's `JoinSessionConfig` still declares `askUserVariant`, and `extension.js` forwards
`askUserVariant` and `requestElicitation` when an extension joins. `Tool.overridesBuiltInTool`
also exists. Neither is proof that a warm join changes the variant of an existing app session: the
runtime documents the variant as resolved at create or cold-resume. Either route would also change
awaiting-input status, notifications and remote answering for every ask. They are deliberately not
used, and remain unverified options.

## Tests

```
node --test --test-timeout=10000
node --check extension.mjs && node --check form.mjs
```

`extension.test.mjs` loads the real `extension.mjs` against a stub host
(`test-support/host.mjs`). The stub resolves `@github/copilot-sdk/extension` to a fake
`joinSession` and records every elicitation request. The tests cover:

- a ten-field typed form round-trip, with the context in the form message
- partial and invalid answers
- decline, dismissal and an unknown action
- an unsupported host, an elicitation error, and sub-agent rejection
- validation of the tool input, including unknown question keys, and that the tool schema
  accepts exactly the keys the validator does
- `enabled: false` in the config, which refuses without showing a form
- the one-form-at-a-time rule
- host abort with a late answer, which is ignored and kept out of the log
- the timeout clamp below 1800 s, using mocked timers, so no test waits

A test that hangs is reported as *cancelled*, not *failed*, so check both counters.

## Known limitations

- Not yet validated in the live app; see the constraints above.
- Forms are capped at 10 questions and 20,000 characters of context.
- Choice values come back as the option labels, so labels must be unique.
