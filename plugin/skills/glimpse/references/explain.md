# Explain existing code

The reader will work on this code next: a new contributor, or the user coming back to a part they have not seen. Give them a map, one path through it, and the rules not to break.

## The page, top to bottom

1. **Lead** (`Text`): what this part is for, in one or two sentences, in terms of what it does for the rest of the system.
2. **Terms** (`KeyValue` of `{label, value}`), only when the code has words of its own: each defined in a line.
3. **The map** (`Layers`, or `Graph('deps.modules path')` when the dependencies are the point): the parts and how they depend on each other, 5 to 12 boxes: a map of the country, not an atlas. Items carry `file=`, and a `CodeView()` beside the map shows whatever the reader clicks.
4. **One path through it** (`SequenceDiagram` or `Flowchart`): the most common request or flow, end to end, every arrow labelled with what it carries. Give an actor `node:'ID'` when it is a box of the map, so clicking one lights the other.
5. **Rules not to break** (`Callout` kind `warn`): invariants, written as what must never happen ("nothing outside the session writes a surface"), each with the file that enforces it.
6. **Where to start reading** (`Steps` with `file=`, or a short `CodeTour`): 3 to 5 stops in reading order, each a few lines with a note on what to notice there.

## Code

Only the stops of the reading order, a few lines each. Everything else opens from the map with a click.

## Before you show it

Could the reader find where to make their first change from this page alone?

Then run the reader check in SKILL.md, for someone who will work on this code next.

## Worked examples

Paths are examples: use real ones from the repository. Copy the order and the restraint, not the words.

### Explain a module

The user asks how a part of the codebase works, or is new to it.

Call `show` with `id`: `auth` and this `spec`:

```
root=Page('How auth works',[lead,terms,map,code,path,rule,start],'src/auth')
lead=Text('Auth turns a login into a session token, then checks that token on every later request. The rest of the API trusts the user it puts on the request.')
terms=KeyValue([{label:'Session token',value:'A signed string the client sends with each request; valid for 15 minutes.'},{label:'Guard',value:'The middleware that checks the token before a route runs.'}],title='Words used here')
map=Layers([{name:'API',items:[{label:'login route',file:'src/api/routes.ts#L12-30'},{label:'guard',file:'src/auth/guard.ts'}]},{name:'Auth',items:[{label:'AuthService',file:'src/auth/service.ts'},{label:'token cache',file:'src/auth/cache.ts'}]},{name:'Storage',items:[{label:'users table',file:'src/db/users.ts'}]}],title='Only the Auth layer reads the users table',span=7)
code=CodeView(title='Click a box to read its code',span=5)
path=SequenceDiagram({steps:[['Client','API','POST /login'],['API','Auth','verify(password)'],['Auth','DB','find user'],['DB','Auth','row','reply'],['Auth','API','token','reply'],['API','Client','200 + token','reply']]},title='A login, end to end')
rule=Callout('Nothing outside src/auth reads the users table or signs a token: the guard is the only way a request gets a user.','warn','A rule not to break',file='src/auth/guard.ts#L5-25')
start=Steps([{title:'The login route',file:'src/api/routes.ts#L12-30',note:'How the body becomes a verify call'},{title:'verify',file:'src/auth/service.ts#L20-58',note:'A constant-time compare, then the token'},{title:'The guard',file:'src/auth/guard.ts#L5-25',note:'What every later request goes through'}],title='Where to start reading')
```

### Trace a request

The user asks what happens when something is called.

Call `show` with `id`: `login` and this `spec`:

```
root=Page('What happens on POST /login',[lead,seq,code,stops])
lead=Text('A login is checked against the stored hash and answered with a token; nothing else is written. The password never leaves the Auth service.')
seq=SequenceDiagram({steps:[['User','API','POST /login'],['API','Auth','verify(password)'],['Auth','DB','find user'],['DB','Auth','row','reply'],['Auth','API','token','reply'],['API','User','200 + token','reply']]},title='One database read, then a token',span=7)
code=CodeView(title='Click a stop to read it',span=5)
stops=Steps([{title:'Route',file:'src/api/routes.ts#L12-30',note:'Parses the body and calls the service'},{title:'Service',file:'src/auth/service.ts#L20-58',note:'A constant-time compare, then the token'}],title='In the code')
```
