# Reference journey (calibration)

A real journey page, written and corrected by a human, from a product called
Handout (publish a finished artifact as a password-protected web page). It is
here as the **measure for form and level of detail** - how long the sentences
are, how concretely the actions are named, how much gets spelled out for a
reader with no prior knowledge.

**It is not a content template.** Do not carry Miriam, the consultancy or the
customer portal into another product. What you carry over is the shape.

Language note: this example is German because that was the product's output
language. Yours follows the user's language; the shape is the same in any
language.

Markup for the page comes from `templates.md`. What follows is the rendered
text.

---

**Page title**

```
J-001: Ein neues Handout veröffentlichen und mit Passwort schützen
```

This tree lives in a space of its own, so its titles carry no product prefix. In
a shared space the same page would be `Handout | J-001: …`. Nothing numbered
Handout's flows before, so the standard scheme applies; with an offer that
numbered them as work packages, the title would start `WP-04: …`.

**Excerpt (`summary`)**

> Miriam veröffentlicht einen fertigen Prototyp als Handout, schützt ihn im
> selben Schritt mit einem Passwort und gibt Adresse und Passwort mit der
> Termineinladung weiter.

**Page properties**

| Epic in Jira | folgt |
| --- | --- |
| Adressierte Kernfähigkeiten | Fertige Artefakte annehmen · Eine dauerhafte Adresse ausgeben · Zugriff an der Adresse schützen · Auf zwei Wegen veröffentlichen · Die eigenen Handouts verwalten |

Each of those is a deep link into the matching heading of the brief, per the
anchor scheme in `confluence-style.md`.

## Auslöser

Mittwoch, zwanzig nach sieben am Abend. Der Prototyp für das Kundenportal ist
fertig. Der Termin mit dem Kunden ist am nächsten Morgen um zehn.

## Journey

Miriam ist Senior Consultant in einer Digitalberatung mit zwölf Leuten. Seit
drei Wochen arbeitet sie für einen regionalen Energieversorger, der sein
Kundenportal ablösen will. Das alte Portal ist inzwischen über zehn Jahre alt
und verträgt eine Auffrischung.

Da Miriam den Prototyp mit Claude Design erstellt hat und sie diesen nicht mit
Personen außerhalb ihrer Organisation teilen kann, entschließt sie sich, den
Prototyp in Handout zu veröffentlichen.

Dafür exportiert sie den Prototyp als einzelne HTML-Seite, die alles (HTML,
CSS, JS) enthält, und speichert sich diese auf ihrem Rechner. Danach loggt sie
sich in Handout ein und erstellt ein neues Handout. Sie lädt die
zwischengespeicherte HTML-Seite hoch und aktiviert die Option, um das Handout
mit einem Passwort zu schützen.

Nachdem das neue Handout veröffentlicht wurde, werden die Adresse zum Handout
und das Passwort zum Kopieren angeboten. Sie kopiert beides und fügt es in die
Termineinladung für den nächsten Morgen ein.

Auf ihrem persönlichen Dashboard sieht sie die bisherigen und auch das neue
Handout. Dort kann sie jederzeit die Adresse und das Passwort des Handouts
kopieren.

Am nächsten Morgen: Der Termin hat begonnen. Jörg Wittmann öffnet die Adresse
aus der Termineinladung, gibt das Passwort ein und hat den Prototyp vor sich.
Seine Mitarbeiter:innen tun dasselbe auf ihren eigenen Rechnern. Alle können
den Prototypen selbständig ausprobieren und dadurch konstruktives Feedback an
Miriam geben.

## Schmerzpunkte heute

**Problem · Der Prototyp kommt nicht aus dem Werkzeug heraus**
Claude Design kann ihn nicht mit Personen außerhalb der eigenen Organisation
teilen. Was sie gebaut hat, bleibt zunächst bei ihr, und der Kunde ist genau
die Person, die es sehen soll.

**Problem · Als Anhang übernimmt der Empfänger die Mechanik**
Sie exportiert eine HTML-Datei und verschickt sie. Der Kunde muss sie speichern
und lokal öffnen, und ob das gelingt, erfährt sie erst im Termin.

**Problem · Sie kann das Material nicht schützen**
Was in einem Postfach liegt, liegt dort ungeschützt und unbefristet. Für
unveröffentlichtes Kundenmaterial ist das die falsche Ablage, und sie hat keine
Alternative.

**Problem · Im Termin probiert niemand selbst aus**
Eine Datei liegt auf einem Rechner. Seine Mitarbeiter:innen können sie nicht
parallel öffnen, also schauen alle auf einen geteilten Bildschirm statt selbst
zu klicken.

## Was die Anwendung ändert

**Lösung · Aus dem Werkzeug heraus nach außen**
Exportieren, hochladen, veröffentlicht. Der Prototyp ist ohne Umweg für
Menschen außerhalb der Organisation erreichbar, ohne dass er dabei die eigene
Infrastruktur verlässt.

**Lösung · Hochladen und Schützen sind ein Schritt**
Beim Anlegen des Handouts aktiviert sie den Passwortschutz. Es gibt keinen
zweiten Schritt, den man vergessen könnte.

**Lösung · Adresse und Passwort bleiben zur Hand**
Beides wird nach dem Veröffentlichen zum Kopieren angeboten und bleibt im
Dashboard abrufbar. Sie muss sich nichts notieren und nichts wiederfinden.

**Lösung · Alle im Termin arbeiten selbst damit**
Jörg Wittmann und seine Mitarbeiter:innen öffnen dieselbe Adresse auf ihren
eigenen Rechnern und probieren parallel aus. Das Feedback entsteht beim
Benutzen, nicht beim Zuschauen.

## Verbundene Arbeitspakete

folgt

---

## What to read off this example

**The four movements sit inside "Journey", not spread over the page.** Paragraph
one is the starting situation (who she is, whose project, what the thing even
is). Paragraph two says why the product enters at all, out loud. Paragraphs
three to five are the actions in order, each one named. The last paragraph is
the outcome: what is different now.

**"Auslöser" is the moment, not the setup.** Three sentences, a weekday and a
time. The situation belongs in the journey text; if you put it in both, it
stands twice.

**The actions are named as actions**: export, save, log in, create, upload,
switch on the option, copy, paste. No reasoning about requirements, no
derivation of a solution.

**Every sentence is something the persona does, sees or gets.** Nothing about
the system's insides, nothing about which part is responsible for what, no
verdict on system behavior, no invented feelings.

**The title names the action**, not the story: "Ein neues Handout
veröffentlichen und mit Passwort schützen".

**There is no Risks section here**, and that is the normal case: nothing in
the dialog made delivering this journey uncertain. The section appears only
when someone names a risk, never to fill the page.

**The pain points name today's world** - the tool, the attachment, the mailbox,
the shared screen - and each one has its counterpart in "Was die Anwendung
ändert". Four and four, in the same order.
