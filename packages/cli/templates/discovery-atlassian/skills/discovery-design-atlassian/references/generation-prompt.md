# Template: Generation prompt

The skill fills this template in at the end: replace `{{PRODUCTNAME}}` with the
product name, `{{DESIGN_BRIEF}}` with the full content of the design brief you
created. Output the result as a **code block** so the user can copy it with a
single click and paste it into Claude Design (or Figma Make).

Product specifics (palette, screens, platform) come from the embedded design
brief - so the template stays generic.

---

You are designing a design system and a hi-fi prototype for {{PRODUCTNAME}}.
The basis is the design brief below; stick to the north star, tone, and design
principles.

Proceed in two steps:

1. Establish the design system first. Tokens: color palette including state
   colors, typography scale, spacing, radii, shadows. Plus a core component set:
   buttons, input fields, cards, lists, navigation, status/badge elements, empty
   states. The system carries the brand personality from the design brief.
2. Build the hi-fi prototype of the key screens on top of it. Each screen uses
   only the system, so everything stays consistent.

Stick to:

- The platform, interaction, and accessibility requirements of the design brief;
  contrast at least AA and state never by color alone as a baseline.
- The imagery described in the design brief; use placeholder images.

Deliverable: the design system as machine-readable tokens (e.g. CSS variables or
JSON) plus components and prototype as code (HTML/CSS or React), so a developer
or coding agent can work on it directly. Not a Figma-only artifact. If the tool
primarily produces Figma, additionally export the tokens and provide a code
handoff.

Design Brief:

{{DESIGN_BRIEF}}
