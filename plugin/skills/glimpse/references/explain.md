# Explain existing code

The reader will work on this code next: a new contributor, or the user coming back to a part they have not seen. Give them a map, one path through it, and the rules not to break.

## The page, top to bottom

1. **Lead** (`Text`): what this part is for, in one or two sentences, in terms of what it does for the rest of the system.
2. **Terms** (`KeyValue` of `{label, value}`), only when the code has words of its own: each defined in a line.
3. **The map** (`Layers`, a `Flowchart` for a whole system, or `Graph('deps.modules path')` when the dependencies are the point): the parts and how they depend on each other, 5 to 12 boxes: a map of the country, not an atlas. Items carry `file=`, and a `CodeView()` beside the map shows whatever the reader clicks.
   - **From the outside in.** For a whole system, the first map is the system as its user meets it: the person is the first box, then the 4 to 6 parts they deal with, and a group for what runs where. Each further plate opens one box of the plate above, one level deeper. Never open on the inside: a reader shown the internals first has nothing to hang them on.
   - **Short labels.** A box says what it is in two to four plain words. What it does goes in its `note=` (shown on hover) and where it lives in `file=`, never in the label: a diagram of long labels opens too small to read.
4. **One path through it** (`SequenceDiagram` or `Flowchart`): the most common request or flow, end to end, every arrow labelled with what it carries. Give an actor `node:'ID'` when it is a box of the map, so clicking one lights the other.
   - **A story, start to finish.** It begins with what the person does and ends with what they get back, and every request has its reply drawn. When it has stages, name each with a note across every lane (`{note:'2. You look around', over:['You','Tab']}`), put what repeats in a `loop`, and say where a part is not involved. A missing step is what a reader notices first.
5. **Rules not to break** (`Callout` kind `warn`): invariants, written as what must never happen ("nothing outside the session writes a surface"), each with the file that enforces it.
6. **Where to start reading** (`Steps` with `file=`, or a short `CodeTour`): 3 to 5 stops in reading order, each a few lines with a note on what to notice there.

## Code

Only the stops of the reading order, a few lines each. Everything else opens from the map with a click.

## Before you show it

Could the reader find where to make their first change from this page alone? Could someone who has never used the system read the first diagram without hovering?

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

### Draw the system

The user asks for a system or architecture diagram, or how the whole thing fits together.

Call `show` with `id`: `system` and this `spec`:

```
root=Page('How the shop works',[lead,map,api,code,order],'From the shopper in')
lead=Text('A shopper uses the web app, and the web app asks the API for everything. Only the API reads or writes the orders database; card numbers go straight to the payment provider.')
map=Flowchart({nodes:{U:{label:'Shopper',shape:'pill'},Web:{label:'Web app',note:'Pages and the cart, in the browser',file:'src/web/app.tsx'},API:{label:'API',group:'ours',note:'Checks the session, then runs the route',file:'src/api/routes.ts'},DB:{label:'Orders database',shape:'store',group:'ours',file:'src/db/orders.ts'},Pay:{label:'Payment provider',note:'Takes the card; we keep only its receipt'}},edges:[['U','Web','browses, orders'],['Web','API','requests with a session'],['API','DB','reads, writes orders'],['Web','Pay','card number'],['Pay','API','receipt']],groups:{ours:{label:'Our servers'}}},dir='LR',title='Only the API touches the orders database')
api=Layers([{name:'Routes',items:[{label:'orders',file:'src/api/orders.ts'},{label:'receipts',file:'src/api/receipts.ts'}]},{name:'Checks',items:[{label:'session guard',file:'src/auth/guard.ts'}]},{name:'Storage',items:[{label:'orders table',file:'src/db/orders.ts',node:'DB'}]}],title='Inside the API: every route passes the guard',span=7)
code=CodeView(title='Click a box to read its code',span=5)
order=SequenceDiagram({actors:{U:{label:'Shopper',node:'U'},Web:{label:'Web app',node:'Web'},API:{label:'API',node:'API'},DB:{label:'Orders database',node:'DB'}},steps:[{note:'1. The shopper orders',over:['U','DB']},['U','Web','press Order'],['Web','API','POST /orders'],['API','DB','insert order'],['DB','API','order id','reply'],['API','Web','201 + order id','reply'],['Web','U','"Order placed"','reply'],{note:'2. The shopper checks on it',over:['U','DB']},['U','Web','open My orders'],['Web','API','GET /orders'],['API','DB','find orders'],['DB','API','rows','reply'],['API','Web','the list','reply'],['Web','U','their orders','reply']]},title='An order is one write; checking on it is one read')
```
