# Design a feature or a system

The reader decides whether this gets built, answers your open questions, and then builds from the page. Draw it before any code is written: a blueprint, not a listing.

## Size the page to the decision

Hold back on code, never on reasoning. A small feature in an existing codebase may be a lead, a diagram, two decisions and a plan. A whole system, or anything a team approves together, carries what its design review asks for: the targets it must meet, the scale it is sized for, every decision with what it costs and what was turned down, and each risk with how bad it is and what limits it. Bring what you know about systems of its kind: the failure a reviewer asks about first (a double booking, a lost message, a charge made twice) is answered on the page, at the step that prevents it.

- **Walk the guarantee through what breaks it.** For the property the design rests on, say what happens when two requests arrive at once, a request is retried, a step times out or fails halfway, the process stops between two writes, and something held expires before it is used. Shown only on the path where all goes well, a guarantee is a claim.
- **Size what each part adds.** A load a part brings (a check on every search, a row per night) is sized from the page's own scale, so the reader sees it fits.

## The page, top to bottom

1. **Lead** (`Text`): what it does for whom and why now, in two or three sentences, then one line on what stays the same, and for a design a team approves, what is asked of it.
2. **What it will do** (`Steps`): 3 to 6 behaviours, each one sentence that could turn out to be false ("a comment marked *send* reaches the agent on its next turn"). Split by behaviour, never by file or layer: read aloud, they tell the whole feature, and they are how the work is checked.
   - **How well**, when there are targets (`KeyValue` or `DataTable`): latency, freshness, availability, what must never happen, and the scale with how each number was reached. A number you chose says it is an assumption.
3. **The shape** (`Flowchart`, `SequenceDiagram` for a conversation between parts, `Layers`, or `ERDiagram` when stored data changes): one diagram of the mechanism, with the new parts in a group named "New" beside the existing parts they touch. A new node gets `note=` (what it does); an existing one gets `file=` (where it lives), so a click opens the code it plugs into.
   - **A whole system** is drawn from the outside in: the people who use it first, short labels, what each box does in `note=`. Then one plate per mechanism worth opening: the main flow as a `SequenceDiagram` with every reply, the stored data as an `ERDiagram`. Where a flow carries a guarantee, a `Steps` beside it says what each stage does and why; the arrows keep short labels.
4. **Decisions** (`Callout` kind `decision`, beside the diagram): one per choice that shapes what gets built: what you chose, why, and the option you turned down and its reason. Four or more compare better as one `DataTable` of rows `{decision, why, cost, rejected}`.
   - **Risks** (`Callout` kind `risk`): every one a reviewer of systems of its kind would raise: an outside provider down, a rush on one item, data out of date, growth past one store, work done twice. The title says how bad (High, Medium) and what; the text says what limits it and how you would know it happened.
5. **Out of scope** (a `Callout` or a `List`): what this will not do, so nobody builds it.
6. **Work plan** (`Steps`): ordered by what unblocks what; each step names the files it touches (`file=`) and the behaviour from part 2 that checks it.
7. **Open questions** (`Ask`): only the forks that change what gets built, 2 to 5, the option you would build first. Each option's `note` says what picking it means or costs: `{label:'Hold the nights 12 h',note:'The guest is sure; the home is off sale meanwhile'}`. A question the code can answer, answer yourself by reading it.

Leave out any part that has nothing to say.

## Code

None, except a contract the parts agree on (an interface, a message shape, a function signature, an example record) in a `CodeBlock` of a few lines titled as a sketch, or a `CodeView` of an existing pattern the new code should copy. A plan longer than the code it describes has already written the code.

## Before you show it

Could the crew start building from this page without asking you anything? What they would ask is the part still missing. Would a reviewer of systems of this kind find their first question answered?

Then check the page against itself, and fix what you find before you draw it: recompute every ratio and total from the page's own figures; count what a title counts ("five services") in its diagram; and look for a part that does what another part's reason rules out (a search that reads the store the search decision keeps it away from).

Then run the reader check in SKILL.md, for the person who decides whether this gets built, and the crew who will build it.

## Worked example

Paths are examples: use real ones from the repository. Copy the order, not the words or the size: this is a small feature, and a larger design adds what its size calls for.

### Design a feature

Before something is built: a blueprint the user reviews and the builders work from.

Call `show` with `id`: `limits` and this `spec`:

```
root=Page('Rate limits per API key',[lead,does,shape,why,scope,plan,ask],'Design, before building')
lead=Text('**What:** each API key may make 100 requests a minute; past that, the API answers 429 with the seconds to wait. **Why:** the batch jobs of one client slowed every other client last week. **Unchanged:** clients under the limit, and the admin routes.')
does=Steps([{title:'A key over 100 requests in a minute gets 429 and a Retry-After header'},{title:'A key under the limit sees no added latency'},{title:'The count resets every minute, per key'},{title:'Admin routes are never limited'}],title='What it will do')
$/shape={groups:{new:'New'},nodes:{Req:'Request',RL:{label:'Limiter',group:'new',note:'Counts requests per key per minute'},C:{label:'Counter store',shape:'store',group:'new'},H:{label:'Route handlers',file:'src/api/routes.ts#L12-40'},E:{label:'429 + Retry-After',shape:'pill',group:'new'}},edges:[['Req','RL','every request'],['RL','C','count +1'],['RL','H','under the limit'],['RL','E','over the limit']]}
shape=Flowchart($/shape,title='Every request passes the limiter before a handler',span=7)
why=Column([Callout('Counts live in memory: there is one instance today. The store is an interface, so Redis can replace it when we run more.','decision','Counter store'),Callout('A fixed one-minute window rather than a sliding one: simpler to reason about. A burst of 200 across a window edge is accepted.','decision','Window'),Callout('The admin router is mounted before the API router, so it skips the limiter. That is wanted; a test pins it.','risk','Admin routes')],span=5)
scope=Callout('Limits per user, quotas per plan, and a report of who was limited.','note','Not in this change')
plan=Steps([{title:'Limiter and counter store',file:'src/api/limiter.ts',note:'Checked by behaviours 1 and 3'},{title:'Mount it in front of the API router',file:'src/api/routes.ts#L12',note:'Checked by behaviour 2'},{title:'Test that admin routes skip it',file:'test/api/admin.test.ts',note:'Behaviour 4'}],title='Work plan')
ask=Ask('What limit should a key get? The first is what I would build.',[{label:'100 a minute',note:'Stops the batch jobs; a burst of 200 across a minute edge passes'},{label:'1,000 an hour',note:'A batch job can still run for minutes before it is stopped'},{label:'Set per key',note:'An admin screen and a column on keys: about a week more'}],'limit')
```
