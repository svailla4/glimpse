# Review a change

The reader decides whether the change can merge, and what to fix first. Lead with your verdict, then the evidence for it.

## The page, top to bottom

1. **Verdict** (`Text`): ready to merge, ready after fixes, or needs rework, and why, in two or three sentences. Then what the change does for its users, as behaviour.
2. **What changed, drawn** (`Flowchart` with groups "Before" and "After", or one diagram with the changed parts in a group "Changed"): the mechanism the change alters, every arrow labelled. A change that alters no mechanism (a rename, a dependency bump) has no diagram: say so in the verdict.
3. **Findings** (`Callout`, worst first): each says the problem as a user of the code would meet it, then where it happens and what sets it off (`file='path#L40'`), then the fix. Kind `risk` for what must be fixed before merging, `warn` for what should be, `note` for a nit, and one `tip` for something done well when there is one. A finding you could not confirm says so.
4. **Where to look** (`Steps`): the files in reading order, the main part first, each with one line on what to check there (`file=`). Files that only follow from the main ones (tests, renames, generated files) come last or not at all.
5. **Choices the change makes** (`Callout` kind `decision`): with their reasons from the commits, the pull request or the decision log, each cited. A reason you inferred says so.
6. **The diff** (`DiffView`), last: in a `Plate` with `collapsed=true` or the last of `Tabs`, for the reader who wants every line.

## Code

A finding may show the few lines it is about: `CodeView('path#L38-46',mark='41')`. The full diff is there, last; the page above it is the reading guide.

## Before you show it

Fit the page to one decision: about eight parts. A choice that changes no code is a line in the verdict, not a plate of its own, and "Where to look" says what to check, not the links the findings already carry. Does every finding name a real file and line, and could the author fix it from the text alone? Read the diff from git (`DiffView('a..b')`): a `CodeView` reads the working tree, which may not be the code under review.

Then run the reader check in SKILL.md, for the person who decides whether this change can merge.

## Worked example

Paths are examples: use real ones from the repository. Copy the order and the restraint, not the words.

### Review a change

The user asks for a review of a branch, a pull request or the working tree.

Call `show` with `id`: `review` and this `spec`:

```
root=Page('Review: rate limits per API key',[lead,shape,risk,warn,good,look,why,diff],'main..HEAD')
lead=Text('**Verdict:** ready after one fix. The limiter counts and resets correctly and is tested, but it also limits the admin routes, which the design ruled out. **What it does:** a key over 100 requests a minute now gets 429 and the seconds to wait.')
$/shape={groups:{before:'Before',after:'After'},nodes:{R1:{label:'Request',group:'before'},H1:{label:'Handlers',group:'before'},R2:{label:'Request',group:'after'},L:{label:'Limiter (new)',group:'after',file:'src/api/limiter.ts'},H2:{label:'Handlers',group:'after'},E:{label:'429',shape:'pill',group:'after'}},edges:[['R1','H1','every request'],['R2','L','every request'],['L','H2','under the limit'],['L','E','over the limit']]}
shape=Flowchart($/shape,title='Requests now pass the limiter before any handler')
risk=Callout('An admin running a bulk export is cut off after 100 requests: the limiter is mounted before the admin router, not after it. **Fix:** mount it after the admin router, and add the test the design asked for.','risk','Must fix: admin routes are limited',file='src/api/routes.ts#L14')
warn=Callout('A limited client never learns its limit, because the 429 body is empty. **Fix:** return the limit and the seconds to wait as JSON.','warn','Should fix: empty 429 body',file='src/api/limiter.ts#L31')
good=Callout('The counter store sits behind an interface, so moving to Redis is one new class.','tip','Done well')
look=Steps([{title:'The limiter',file:'src/api/limiter.ts',note:'The window reset and the Retry-After value'},{title:'Where it is mounted',file:'src/api/routes.ts#L10-20',note:'Its order against the admin router'},{title:'The tests',file:'test/api/limiter.test.ts',note:'They cover the window; no admin case yet'}],title='Where to look, in order')
why=Callout('A fixed one-minute window rather than a sliding one, for simplicity (the commit message says so).','decision','A choice the change makes')
diff=Plate('Every line',[DiffView('main..HEAD')],collapsed=true)
```
