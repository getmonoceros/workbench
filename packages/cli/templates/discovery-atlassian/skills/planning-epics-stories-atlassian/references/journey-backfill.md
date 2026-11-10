# Journey backfill: writing the epic and its stories onto the journey page

The journey page arrives from the discovery skill with two `to follow`
placeholders. **Planning is the only skill that fills them with real data.**
That includes a yellow journey, which gets its epic before its stories: the
macro below then shows an empty table, and fills itself once the stories exist.
Overwrite both, whatever stands there - `to follow` or an old, dead epic key
from an earlier run.

## 1. The "Epic in Jira" row

The row becomes the real epic card of **this** run. It sits in the
page-properties table at the top of the journey page.

**Write the table as one single `<tbody>`**: left cell `<th>` (the label, so it
renders as a header column), right cell **`<td>`** (the epic card). **No
`<thead>`.**

Why this matters: the HTML+ read wrongly returns the first row inside a
`<thead>`. Writing that back one to one makes Confluence turn the value `<td>`
into a `<th>`, and the row renders as a gray header **row** instead of a header
**column**. So dissolve the `<thead>` into `<tbody>` on write-back and keep the
value cell as a `<td>`.

## 2. The "Related work items" section

The plain `to follow` paragraph becomes the **classic Jira issues macro** with

```
jqlQuery = parent = <epic key of this run> ORDER BY key ASC
```

That macro needs **only the JQL**. No datasource `id`, no `cloudId`, nothing to
look up - you already have the epic key, you just created it. Exact markup:

```html
<div data-type="extension" data-extension-key="jira" data-extension-type="com.atlassian.confluence.macro.core" data-parameters="{&quot;macroParams&quot;:{&quot;columns&quot;:{&quot;value&quot;:&quot;key,summary,type,status&quot;},&quot;jqlQuery&quot;:{&quot;value&quot;:&quot;parent = <EPIC-KEY> ORDER BY key ASC&quot;}},&quot;macroMetadata&quot;:{&quot;schemaVersion&quot;:{&quot;value&quot;:&quot;1&quot;}}}"></div>
```

That way the journey shows its epic and the live table of its stories.

## A story that serves two journeys

It has exactly one parent epic, so it appears in exactly one journey's macro
table - the journey where the persona triggers the function. The other journey
reaches it through the inline card in the story's business context. Do not add a
second macro or a manual list to the other page.
