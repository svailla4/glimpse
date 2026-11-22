// The plugin's skill and commands, generated from the catalog so they always agree with it (decision
// views-are-blueprints). One skill, not one per task: the core (SKILL.md) says what every view does and routes to one
// guide per task (references/<guide>.md), each with its page order and the worked examples of EXAMPLES that belong to
// it. Two skills that both teach what to draw compete, and a model follows one and drops the other's rules; a guide is
// read only for the task at hand. Each command (/glimpse:design, review, explain) loads the skill with its guide.
// scripts/build.mjs writes every file of pluginFiles(); test/mcp/plugin.test.ts checks the files on disk are these.
import {EXAMPLES, serverInstructions, type Example, type GuideName} from './docs.ts';

export const SKILL_NAME = 'glimpse';

/** When to load the skill, never what it says: a model that reads a summary of the workflow follows the summary. */
export const SKILL_DESCRIPTION =
  'Draw live views of a codebase in the local Glimpse browser tab: designing or planning a feature or a system before it is built, reviewing a change or a pull request, explaining existing code or onboarding onto it, and quick looks (overview, dependency map, hotspots, history, a file, a diff). Use whenever the user asks to see, show, visualize, map, design, plan, review, explain or walk through code, or when a picture of the code would answer faster than text.';

/**
 * The fresh reader's questions (SKILL.md, "The reader check"); `<who>`, `<act>` and `<root>` are filled in by the
 * author. Question 6 is the one a reader of the page alone cannot answer: in the benchmark that tested this skill, the
 * pages that won still carried a wrong budget figure and a line range that opened the wrong function.
 */
export const READER_PROMPT = `You have never seen this project, but you know software. This is a page drawn for <who> so they can <act>. Parts written as a source, such as 'git.churn src top=10', are tables and charts the tab fills from the repository; [[path#L10]] and file: values are links to code.
1. In two sentences: what does the page tell you is being built, changed or explained, and why? If you cannot say, say what stopped you.
2. Which words or names would you have to look up?
3. For each figure, its one claim in a sentence. Name any figure whose claim you cannot state, and any arrow without a label.
4. Where does code or detail crowd out the intent? Which part has nothing to say?
5. What would you still have to ask before you could <act>?
6. Only now, open the repository at <root>: pick the three claims the decision rests on most (a number, a line range, what a part does) and check them. Say which are wrong.
Answer in under 250 words.`;

/**
 * `copy`: what to take from the guide's worked examples, when not "the order and the restraint". The design example is
 * a small feature, and "the restraint" made a whole-system design as small as it (decision design-depth-follows-the-decision).
 */
interface Guide { name: GuideName; title: string; command: string; argument: string; scope?: string; reader: string; act: string; body: string; copy?: string }

/** One guide per task: who reads the page, its parts in order, how much code, and what to check before showing it. */
export const GUIDES: readonly Guide[] = [
  {
    name: 'design', title: 'Design a feature or a system', command: 'Design a feature or a system as a Glimpse blueprint to review before it is built',
    argument: '<what to build>', reader: 'the person who decides whether this gets built, and the crew who will build it', act: 'build it',
    copy: 'Copy the order, not the words or the size: this is a small feature, and a larger design adds what its size calls for.',
    body: `The reader decides whether this gets built, answers your open questions, and then builds from the page. Draw it before any code is written: a blueprint, not a listing.

## Size the page to the decision

Hold back on code, never on reasoning. A small feature in an existing codebase may be a lead, a diagram, two decisions and a plan. A whole system, or anything a team approves together, carries what its design review asks for: the targets it must meet, the scale it is sized for, every decision with what it costs and what was turned down, and each risk with how bad it is and what limits it. Bring what you know about systems of its kind: the failure a reviewer asks about first (a double booking, a lost message, a charge made twice) is answered on the page, at the step that prevents it.

## The page, top to bottom

1. **Lead** (\`Text\`): what it does for whom and why now, in two or three sentences, then one line on what stays the same.
2. **What it will do** (\`Steps\`): 3 to 6 behaviours, each one sentence that could turn out to be false ("a comment marked *send* reaches the agent on its next turn"). Split by behaviour, never by file or layer: read aloud, they tell the whole feature, and they are how the work is checked.
   - **How well**, when there are targets (\`KeyValue\` or \`DataTable\`): latency, freshness, availability, what must never happen, and the scale with how each number was reached. A number you chose says it is an assumption.
3. **The shape** (\`Flowchart\`, \`SequenceDiagram\` for a conversation between parts, \`Layers\`, or \`ERDiagram\` when stored data changes): one diagram of the mechanism, with the new parts in a group named "New" beside the existing parts they touch. A new node gets \`note=\` (what it does); an existing one gets \`file=\` (where it lives), so a click opens the code it plugs into.
   - **A whole system** is drawn from the outside in: the people who use it first, short labels, what each box does in \`note=\`. Then one plate per mechanism worth opening: the main flow as a \`SequenceDiagram\` with every reply, the stored data as an \`ERDiagram\`. Where a flow carries a guarantee, a \`Steps\` beside it says what each stage does and why; the arrows keep short labels.
4. **Decisions** (\`Callout\` kind \`decision\`, beside the diagram): one per choice that shapes what gets built: what you chose, why, and the option you turned down and its reason. Four or more compare better as one \`DataTable\` of rows \`{decision, why, cost, rejected}\`.
   - **Risks** (\`Callout\` kind \`risk\`): the title says how bad (High, Medium) and what; the text says what limits it.
5. **Out of scope** (a \`Callout\` or a \`List\`): what this will not do, so nobody builds it.
6. **Work plan** (\`Steps\`): ordered by what unblocks what; each step names the files it touches (\`file=\`) and the behaviour from part 2 that checks it.
7. **Open questions** (\`Ask\`): only the forks that change what gets built, 2 to 5, the option you would build first. Each option's \`note\` says what picking it means or costs: \`{label:'Hold the nights 12 h',note:'The guest is sure; the home is off sale meanwhile'}\`. A question the code can answer, answer yourself by reading it.

Leave out any part that has nothing to say.

## Code

None, except a contract the parts agree on (an interface, a message shape, a function signature, an example record) in a \`CodeBlock\` of a few lines titled as a sketch, or a \`CodeView\` of an existing pattern the new code should copy. A plan longer than the code it describes has already written the code.

## Before you show it

Could the crew start building from this page without asking you anything? What they would ask is the part still missing. Would a reviewer of systems of this kind find their first question answered?`,
  },
  {
    name: 'review', title: 'Review a change', command: 'Review a branch, a pull request or the working tree as a Glimpse page',
    argument: '[a git range, a pull request number, or nothing]',
    scope: 'With nothing given, review the working tree when it has changes, else the current branch against the default branch. For a pull request number, read it with `gh pr view` and review its range.',
    reader: 'the person who decides whether this change can merge', act: 'decide whether it can merge and what to fix first',
    body: `The reader decides whether the change can merge, and what to fix first. Lead with your verdict, then the evidence for it.

## The page, top to bottom

1. **Verdict** (\`Text\`): ready to merge, ready after fixes, or needs rework, and why, in two or three sentences. Then what the change does for its users, as behaviour.
2. **What changed, drawn** (\`Flowchart\` with groups "Before" and "After", or one diagram with the changed parts in a group "Changed"): the mechanism the change alters, every arrow labelled. A change that alters no mechanism (a rename, a dependency bump) has no diagram: say so in the verdict.
3. **Findings** (\`Callout\`, worst first): each says the problem as a user of the code would meet it, then where it happens and what sets it off (\`file='path#L40'\`), then the fix. Kind \`risk\` for what must be fixed before merging, \`warn\` for what should be, \`note\` for a nit, and one \`tip\` for something done well when there is one. A finding you could not confirm says so.
4. **Where to look** (\`Steps\`): the files in reading order, the main part first, each with one line on what to check there (\`file=\`). Files that only follow from the main ones (tests, renames, generated files) come last or not at all.
5. **Choices the change makes** (\`Callout\` kind \`decision\`): with their reasons from the commits, the pull request or the decision log, each cited. A reason you inferred says so.
6. **The diff** (\`DiffView\`), last: in a \`Plate\` with \`collapsed=true\` or the last of \`Tabs\`, for the reader who wants every line.

## Code

A finding may show the few lines it is about: \`CodeView('path#L38-46',mark='41')\`. The full diff is there, last; the page above it is the reading guide.

## Before you show it

Fit the page to one decision: about eight parts. A choice that changes no code is a line in the verdict, not a plate of its own, and "Where to look" says what to check, not the links the findings already carry. Does every finding name a real file and line, and could the author fix it from the text alone? Read the diff from git (\`DiffView('a..b')\`): a \`CodeView\` reads the working tree, which may not be the code under review.`,
  },
  {
    name: 'explain', title: 'Explain existing code', command: 'Explain a part of the codebase, or how something works, as a Glimpse page',
    argument: '<a part of the code, or a question about how it works>', reader: 'someone who will work on this code next', act: 'start working on it',
    body: `The reader will work on this code next: a new contributor, or the user coming back to a part they have not seen. Give them a map, one path through it, and the rules not to break.

## The page, top to bottom

1. **Lead** (\`Text\`): what this part is for, in one or two sentences, in terms of what it does for the rest of the system.
2. **Terms** (\`KeyValue\` of \`{label, value}\`), only when the code has words of its own: each defined in a line.
3. **The map** (\`Layers\`, a \`Flowchart\` for a whole system, or \`Graph('deps.modules path')\` when the dependencies are the point): the parts and how they depend on each other, 5 to 12 boxes: a map of the country, not an atlas. Items carry \`file=\`, and a \`CodeView()\` beside the map shows whatever the reader clicks.
   - **From the outside in.** For a whole system, the first map is the system as its user meets it: the person is the first box, then the 4 to 6 parts they deal with, and a group for what runs where. Each further plate opens one box of the plate above, one level deeper. Never open on the inside: a reader shown the internals first has nothing to hang them on.
   - **Short labels.** A box says what it is in two to four plain words. What it does goes in its \`note=\` (shown on hover) and where it lives in \`file=\`, never in the label: a diagram of long labels opens too small to read.
4. **One path through it** (\`SequenceDiagram\` or \`Flowchart\`): the most common request or flow, end to end, every arrow labelled with what it carries. Give an actor \`node:'ID'\` when it is a box of the map, so clicking one lights the other.
   - **A story, start to finish.** It begins with what the person does and ends with what they get back, and every request has its reply drawn. When it has stages, name each with a note across every lane (\`{note:'2. You look around', over:['You','Tab']}\`), put what repeats in a \`loop\`, and say where a part is not involved. A missing step is what a reader notices first.
5. **Rules not to break** (\`Callout\` kind \`warn\`): invariants, written as what must never happen ("nothing outside the session writes a surface"), each with the file that enforces it.
6. **Where to start reading** (\`Steps\` with \`file=\`, or a short \`CodeTour\`): 3 to 5 stops in reading order, each a few lines with a note on what to notice there.

## Code

Only the stops of the reading order, a few lines each. Everything else opens from the map with a click.

## Before you show it

Could the reader find where to make their first change from this page alone? Could someone who has never used the system read the first diagram without hovering?`,
  },
];

/** A recipe as the skill prints it: when, the call, the spec. */
function recipe(example: Example): string {
  const lines = [`### ${example.title}`, '', example.when, ''];
  if (example.view) lines.push(`Call \`show\` with \`view\`: \`${example.view}\`${example.spec ? ' and this `spec`:' : '.'}`, '');
  else lines.push(`Call \`show\` with \`id\`: \`${example.id ?? 'main'}\` and this \`spec\`:`, '');
  if (example.spec) lines.push('```', example.spec, '```', '');
  return lines.join('\n');
}

/** plugin/skills/glimpse/references/<guide>.md: the guide and its worked examples. */
export function guideMarkdown(guide: Guide): string {
  const examples = EXAMPLES.filter(e => e.guide === guide.name);
  return `# ${guide.title}

${guide.body}

Then run the reader check in SKILL.md, for ${guide.reader}.

## Worked example${examples.length > 1 ? 's' : ''}

Paths are examples: use real ones from the repository. ${guide.copy ?? 'Copy the order and the restraint, not the words.'}

${examples.map(recipe).join('\n')}`;
}

/** plugin/commands/<guide>.md: a slash command (/glimpse:<guide>) that loads the skill with its guide. */
export function commandMarkdown(guide: Guide): string {
  return `---
description: ${guide.command}
argument-hint: ${guide.argument}
---

Use the \`${SKILL_NAME}\` skill and read its \`references/${guide.name}.md\` before writing the spec.

${guide.title}: $ARGUMENTS
${guide.scope ? `\n${guide.scope}\n` : ''}
Read the code it concerns first. Draw the page in Glimpse with \`show\`, run the reader check from the skill and patch what it finds. Then tell me in a few lines what the page shows and what it asks of me.
`;
}

/** plugin/skills/glimpse/SKILL.md: what every view does, where each task's guide is, the spec reference, quick recipes. */
export function skillMarkdown(): string {
  const quick = EXAMPLES.filter(e => !e.guide);
  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Glimpse

Glimpse draws live views of the repository in a browser tab beside the conversation, through the \`show\` tool of the \`glimpse\` MCP server. You write a short spec that names components and data sources; the server checks it, computes the data and the tab draws it. The reader can click and answer, and what they do comes back to you.

## First: what is the view for?

A view earns its place when the reader understands faster by seeing than by reading: how parts connect, what a change touches, where the risk is. When two lines of text would answer, answer in the chat.

Then pick the task and read its guide (next to this file) before you write the spec. Each guide gives the parts of the page in order and a worked example.

| The user wants to | Read |
|---|---|
${GUIDES.map(g => `| ${{design: 'design or plan something before it is built: a feature, or a whole system', review: 'review a change: a branch, a pull request, the working tree', explain: 'understand existing code: a system or architecture diagram, how a part works, what happens when something is called, getting started on it'}[g.name]} | \`references/${g.name}.md\` |`).join('\n')}
| take a quick look: the overview, dependencies, hotspots, history, a file, a diff, two modules side by side | a preset view, or a quick recipe below |

## What every view does

The page is a blueprint handed to the people who will build, approve or maintain the code: they should be able to act on it without asking you.

1. **The first screen is the answer.** Someone who reads only the top knows what this is, why it matters and what is asked of them, within half a minute: a \`Text\` lead of two or three sentences.
2. **Intent before mechanics.** Say what the code does, or will do, for someone ("a client over its limit is told when to retry") before files, layers or functions. Draw the same way: start from the person who uses it, then go one level deeper per figure.
3. **Plain words.** Name things the way the reader knows them. Define a word of the project before using it (a \`KeyValue\` of terms), and write out codes and abbreviations.
4. **One figure, one claim.** Each diagram or chart makes one point, and its \`title=\` states it as a sentence ("Every request passes the limiter first"), not a label ("Architecture"). Every arrow says what moves along it (\`'count +1'\`, \`'over the limit'\`). To compare, draw the difference: before and after, or the new parts in a group of their own.
5. **Code is evidence.** Show code only where a few lines prove or illustrate a point: a contract, a pattern to copy, the line with the bug. Cite real lines (\`'path#L10-24'\`), mark the ones that matter and say in a note why they are there. The rest of the code is one click away (below), not on the page.
6. **Say what does not change.** What stays the same and what is out of scope are part of the picture; a reader trusts a change whose edges are drawn.
7. **Every reason and every number has a source.** Reasons come from the code, the commits, the pull request, a decision log or the user; a reason you inferred says so ("inferred from the tests"), and a reason you cannot find is left out. A number, a count or a line range on the page was read in this session, not remembered or estimated: take counts from \`query\` or the code, and open the file to check that \`path#L10-24\` starts at the thing you name (the server checks that a file exists, not what its lines hold).
8. **Only parts with something to say.** Leave out a plate that would be empty, generic or a list of every file. A shorter page that is all signal reads faster.

## Use the live tab

The tab is not a document sent once. Use what a static page cannot do:

- **Intent on the page, code on a click.** A Flowchart node, a Layers item or a Steps item with \`file='path#L10-30'\`, a table row with a \`path\` or \`file\` field, and the file link of a Callout select that place when clicked, and a \`CodeView()\` with no file shows whatever is selected. The page stays at the level of intent and every box still opens its code.
- **Link the parts.** \`node:'Q'\` on an ER table, a Layers item, a Steps item or a sequence actor ties it to Flowchart node \`Q\`: clicking one lights the others.
- **Ask in the tab.** For the 2 to 5 choices only the reader can make, an \`Ask\` with the option you recommend first. The pick comes back to you as a \`viewer:\` line; no answer means the question was not read, not that it was agreed.
- **Name the parts and patch them.** Give each part a name (\`why=Callout(...)\`) and change only what changed (\`show{id, spec:"why=Callout(...)"}\`). The reader keeps their place; in the chat, say only what changed.

## The reader check

Before you tell the user a design, a review or an explanation is ready (not for a quick look or a small patch), check it with a reader who has not seen this conversation:

1. Draw the page with \`show\`.
2. Start a fresh agent with no context from this conversation (in Claude Code, the Agent tool). Give it the spec you sent, the \`show\` result and this prompt, with \`<who>\` and \`<act>\` filled in from the guide and \`<root>\` the repository's path:

${READER_PROMPT.split('\n').map(line => `   > ${line}`).join('\n')}

3. Patch what it found, then tell the user. Without a way to start an agent, answer the six questions yourself, as strictly as a stranger would.

## Writing the spec

\`\`\`
${serverInstructions()}
\`\`\`

## Quick recipes

Each recipe is a complete \`show\` call. Paths are examples: use real ones from the repository.

${quick.map(recipe).join('\n')}
## Rules of thumb

- Start from a preset (\`show{view:"overview"}\`) and patch it by id (\`show{id:"overview", spec:"$/notes='...'"}\`); write a full spec only when no preset fits.
- Name sources instead of pasting data. \`query{ref}\` returns a few rows as text when you need facts to talk about.
- Give every part you may change later a name (\`notes=Text(...)\`), then patch it by name. A new name in a patch is added at the end of the page.
- Before writing rows by hand for a component you have not used, ask \`catalog{names:["Steps"]}\`: the answer shows the shape with an example.
- Read the result. An \`E_\` line means nothing was rendered: resend only the failing part. A \`warn\` line (or a \`viewer: error\` line on a later result) means the view is up but one part could not draw what you asked: fix that part. A truthful empty state, such as no import cycles or a clean working tree, is not reported.
- Field names you guess are checked against the source: a near miss is corrected (\`fixed x 'churn' -> 'commits'\`), an unknown one is dropped and the chart picks its own axis. For churn per module, use \`'git.churn by=module'\`.
`;
}

/** Every generated plugin file, by path under plugin/. */
export function pluginFiles(): Record<string, string> {
  const files: Record<string, string> = {[`skills/${SKILL_NAME}/SKILL.md`]: skillMarkdown()};
  for (const guide of GUIDES) {
    files[`skills/${SKILL_NAME}/references/${guide.name}.md`] = guideMarkdown(guide);
    files[`commands/${guide.name}.md`] = commandMarkdown(guide);
  }
  return files;
}

