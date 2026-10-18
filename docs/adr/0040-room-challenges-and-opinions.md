# ADR-0040: Room challenges, a more forward host, and opinions on everything

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0012 (the host's safety rules on opinions), ADR-0016 (the moderator's policy), ADR-0031 (which messages are questions), ADR-0037 (quiet moments)

## Context

The owner wants a host that takes the lead more, keeps people watching,
gets the room doing things together, answers far more questions, and has
opinions, including controversial ones. TikTok recommends LIVEs on how
people engage: likes, comments, shares, follows, how long they stay, and
gifts. Most viewers never type; the ones who do mostly don't end their
questions with "?", so the host let them expire as plain chat. And a host
that answers "as an AI I don't have opinions" gives people nothing to argue
with.

## Decision

### Challenges for the whole room

Four minutes in, then every six (`persona.challenges`, on when unset), a
challenge for everyone, in turn (`runtime/challenges.ts`):

- **Desafio das curtidas:** a like target in 45 s, set from the room's own
  like rate (1.6 times what it usually sends in that time, at least 50 and
  12 per viewer).
- **Sorteio relâmpago:** type EU in 25 s to enter; one winner is drawn and
  picks the next minigame (ADR-0039's pick). Free to enter; the prize is a
  moment on stream.
- **Chuva de comentários:** messages with a word in 30 s, one per viewer
  every 1.5 s.

Only with two or more people watching, never during a game, a podium, a
vote or a pick. A banner under the character shows the count and the
clock. Beating one is a party, and the host pays a prize right away (a
victory song, a spicy hot take, a narrator's replay, a confession). Entries
are taken out of chat like game answers.

### A host that leads

- New quiet-moment ideas: a roll call ("digita 1"), interviewing a viewer
  by name, teasing what's up next, a spicy take, asking for follows and
  shares, fortune-telling about someone in chat.
- People here for the first time are welcomed by name, three at a time, at
  most every 45 s, before the call to passers-by.
- New calls to passers-by: free raffles, the betting games, "a IA responde
  tudo".
- Seven new talk formats for the automatic run of show: Pergunta sem
  filtro, Tribunal do chat, Red flag ou green flag, Ranking sem dó,
  Previsões da IA, Teorias da conspiração, and a sharper Opinião polêmica.

### More questions answered

- A message that reads as a question in Portuguese counts as one without
  its "?" ("oq vc acha do neymar", "me fala uma curiosidade", "opina sobre
  pizza doce"): it gets a question's priority and a minute to be answered,
  and comes back if the host moved past it.
- Questions the host moved past wait two minutes (was 90 s), five at a time
  (was three).

### Opinions

- **Every mode:** the host has an opinion about everything and gives it:
  picks a side, defends it with humor, roasts when asked. No "it depends".
  Medical, legal and financial advice stays out unless it's clearly an
  opinion. The moderator's policy says hot takes on sports, food,
  celebrities, pop culture and internet fights are safe, even harsh ones,
  when they don't attack a group of people.
- **Padrão:** politics and religion are something to joke about, without
  taking sides.
- **Sem filtro** (`strictness: "spicy"`, new): opinions on politics and
  religion too, criticism of politicians, governments, public figures and
  brands, dark humor and light swearing.
- **Every mode, sem filtro included,** keeps out hate and slurs against
  people for who they are, telling anyone how to vote (or anything about how
  or when to vote), harassing a viewer, and sexual content. These are what
  get a LIVE banned, and an AI host making electoral propaganda is
  regulated in Brazil.

## Options considered

- **Hateful or "anything goes" opinions:** the owner asked for politically
  incorrect takes. Hate against groups is what TikTok bans accounts for,
  and it would end the stream's reach and its gifts; sem filtro goes as far
  as it can without that.
- **Paid raffles (gift to enter):** a lottery for gifts is gambling under
  TikTok's rules. The raffle is free.
- **Challenges on a fixed clock regardless of the room:** an empty room
  can't hit a target, and a missed challenge with nobody there is sad.

## Consequences

- Easier: the stream has a beat every few minutes that gets everyone doing
  something, and the like and comment counts TikTok reads go up with it.
- Harder: more on screen, more turns competing for the host; sem filtro
  draws more reports, which the safety page says.
- Revisit: challenge targets on very big streams, and how often a room can
  take a challenge before it's noise.

## Action Items

1. [x] `RoomChallenge`, the `challenge` message and banner, the `raffle` alert.
2. [x] Quiet-moment ideas, welcomes, new hooks and talk formats.
3. [x] Question detection without "?", longer-owed questions.
4. [x] Opinion rules in the prompt and the moderator; sem filtro on the safety page.
5. [ ] Watch a real stream: which challenge moves the numbers most, and how the moderator treats sem filtro.
