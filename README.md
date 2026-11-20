# Glimpse

Generative UI for codebases. Glimpse is an [A2UI](https://a2ui.org) component library plus an MCP server that lets a coding agent render rich, interactive views of any repository — architecture diagrams, dependency graphs, sortable tables, charts, diff walkthroughs — in a local viewer, without the agent writing HTML.

> Status: early development.

## Why

Asking a model to write a full HTML page for every explanation is slow and token-heavy. Glimpse flips that around:

- **A fixed, well-designed component catalog.** The agent emits a compact A2UI spec that references components by name; the viewer renders them.
- **Data stays on your machine.** Analysis tools in the MCP server compute file trees, dependency graphs and git statistics locally and bind them straight into the UI's data model, so large datasets never pass through the model.
- **Standard protocol.** The wire format is A2UI, so the catalog works with any A2UI-capable agent.

## Layout

```
packages/
  catalog/   component catalog definition (schemas shared by server and viewer)
  viewer/    React renderer and component library
  server/    MCP server, local viewer host, codebase analyzers
```
