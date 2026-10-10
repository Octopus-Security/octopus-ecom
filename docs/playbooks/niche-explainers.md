# Explainer channel: one topic you can teach

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** The shop channel and the story channel each have four public videos, and you are opening one teaching channel.

Pick one topic you can explain from work you have done, for twenty videos, without inventing a new identity each week. Honest topics for this estate are narrow: running a small print shop, reading a fee, setting up a home server, training for a fight camp if that is your training. The channel promise is that topic. A video is one question, with a start, the steps, and the mistake you would not repeat.

NOT THIS CHANNEL. verified 2026-10-10 - https://support.google.com/youtube/answer/1311392 An AI persona presented as a human expert on health, law, finance, or politics is not allowed to monetize. No AI doctor, no AI lawyer, no AI host telling people what to do with their money. You may use a model to edit a script you wrote or to make a diagram. The judgment in the video is yours. The face on screen is not a credentialed stranger.

ORIGINAL. Each video answers a different question. Five tips with the nouns swapped is a template. Show the actual screen, the actual fee line, the actual sketch. A slideshow of sentences with no demonstration is the kind of video that page lists as outside monetization.

MONEY. Same thresholds as the story channel. verified 2026-10-10 - https://www.youtube.com/creators/partner-program/ Before ads, the video can point at a kit or a product only after the question is answered, and only at something you sell that the video used. One link. Say that you sell it.

The cleaned scripts can become a second kit later (niche-digital-kit). Do not sell a script that recites another site's article.

## Steps

1. [ ] **Write the topic sentence and twenty questions in ~/octopus-content/explainers/ABOUT.md** (`topic`)
   If you cannot list twenty questions from experience, narrow the topic. Drop any question that needs a license you do not hold.
2. [ ] **Create the channel with the niche-channels playbook. About repeats the topic sentence and who you are, in plain words** (`channel`)
3. [ ] **Script one 6 to 10 minute video that demonstrates the thing. Produce it with the produce-one-video playbook** (`pilot`)
4. [ ] **Use your voice, or a synthetic voice you licensed, and set Studio's disclosure to match. No expert persona that is not you** (`voice`)
   verified 2026-10-10 - https://support.google.com/youtube/answer/1311392
5. [ ] **At most one link, after the answer, to something you sell that the video used** (`link`)
6. [ ] **Publish four, then read retention in Studio before you write the next six** (`four`)
   Where that graph sits in Analytics is assumed, unverified. Use the Analytics page you see.
7. [ ] **If the four are worth repeating, add the cleaned scripts to the kit folder. If not, do not package them** (`kit`)
8. [ ] **If video three needed a fake expert to exist, stop the channel** (`stop`)
9. [ ] **Do not post these videos on the story channel. Different promise** (`separate`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
