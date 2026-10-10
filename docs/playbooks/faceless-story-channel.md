# Faceless story channel: original fiction, footage you own

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** You want the long-form channel people describe as gameplay under a narrated story, and you want it eligible to monetize.

The format is one voice telling one story, captions, and motion on screen, in a video long enough to sit with (a 2,000 to 4,000 word script is a planning range for roughly 15 to 30 minutes; pace is assumed, unverified). The style people mean is a picture that keeps moving while the story is told: a side view, a character or a camera travelling through a place, the way an endless runner feels. The picture changes when the story changes. That bed is yours. It is not a recording of someone else's game.

THE PICTURES, TWO WAYS.
1. An original design you animate. One character you drew or generated, and a handful of places, panned or looped in short stretches. The character can recur. The places follow this story.
2. A video model, one clip per beat. beats.md carries a prompt for that stretch: where they are, what moves, the mood, in your own words. Generate the clip, put it in footage/, and write the model name and the prompt in rights.txt. This shop's image generator makes print designs. It does not make these clips. Use a video model whose terms you have read and that allow ads. Which product that is, is assumed, unverified until you read the terms of the one you pick.

Do not feed a model a frame from Subway Surfers or any other commercial game, and do not name that game, its characters, or its interface in the prompt. A lookalike can draw the same strike as a rip.

COPYRIGHT. There is no step in this playbook for downloading gameplay. A commercial game's footage is not yours, and neither is another creator's recording of it.

MONETIZATION. verified 2026-10-10 - https://support.google.com/youtube/answer/1311392
- Reused content includes readings of materials you did not create, and the page gives text from websites or news feeds as the example. A channel that is Reddit posts read aloud is that example. The same page says the reused-content rule applies even when you have permission from the original creator.
- Repetitive content includes templated storylines, minimal variation from video to video, and AI output from a generic template with none of your own perspective.
- The same page allows a character and narrative you invented, and AI used to make a background that belongs to that narrative. A shared intro is fine. The episode has to be a different story.

So the channel is original fiction in the shape viewers already sit through: one person, one mess, a turn, an ending. You may read public posts to learn which situations people finish. You may not read the post on the video. Same rule this shop uses for other sellers: themes, not the work.

VARIATION. Each video needs its own plot, its own scene list, and pictures that follow the scenes. One identical loop under every upload is a template, whether you drew it or a model did. A recurring character is fine. Quiet stretches can reuse a short loop you made. The places and the generated beats change with the plot. The same page that allows a background a model made for a narrative you invented still refuses a generic template with no change from video to video. verified 2026-10-10 - https://support.google.com/youtube/answer/1311392

RIGHTS, BEFORE UPLOAD. ~/octopus-content/story/<yyyy-mm-dd-slug>/rights.txt names the script (you, or a person you paid), the voice (yours, or a commercial license that covers ads), the music (YouTube's audio library or a license), and every clip. A line that says "found online" means you do not upload.

ADS, WHEN. verified 2026-10-10 - https://www.youtube.com/creators/partner-program/
- Fan funding, shopping, gifts, supers, memberships, partnerships: 500 subscribers, 3 public uploads in 90 days, and either 3,000 long-form watch hours in 365 days or 3 million Shorts views in 90 days.
- Ads and YouTube Premium revenue: 1,000 subscribers, and either 4,000 long-form watch hours in 365 days or 10 million Shorts views in 90 days.
Shorts watch time does not count toward the 4,000 hours. Meeting the number does not admit you; the channel is reviewed, and the creators page says that review is often about a month. assumed, unverified (a 2026-08-10 news report, https://www.theverge.com/streaming/977474/youtube-partner-program-new-requirements, said that from 2027-02-01 new applicants would need 8,000 watch hours or 20 million Shorts views, and that people already in the program stay on the old entry bar if they accept new terms by 2027-01-31; the creators page read on 2026-10-10 still lists 4,000 hours and 10 million Shorts views, so follow the creators page until you have read YouTube's own notice)
Until those ads exist, the description can sell a live shop listing and, later, the kit.

WHERE A NEW TOOL GOES. Your money tools stay private. A new process gets its own repo, its own secret, and a hub.json with "access": "private" and its own subdomain. It does not share a process with the Discord bot, a shell, or anyone else's keys. The Discord bot in cortex is already the owner remote: it answers only DISCORD_USER_ID, and the public image strips it. A command that spends money or changes a stack stays behind the bot's existing 2FA list. Other people's access waits until you are being paid and you say so. No public content app in this pass.

CADENCE. Two long videos a week is enough to learn. One a day of the same shape is the mass-production pattern. If you cannot summarize the plot in two sentences that would not describe last week's video, do not record it.

BOUNDARY. Stories only. No financial, legal, or health advice, and no AI face playing an expert. Characters are fictional. A real private person's name does not go in. Public figures and real crimes are a defamation problem; leave them out.

## Steps

1. [ ] **Pick a name and handle that say fiction, not Reddit and not a game. Create the channel with the niche-channels playbook** (`name`)
2. [ ] **Create ~/octopus-content/story and one folder per video named yyyy-mm-dd-slug** (`folder`)
3. [ ] **Choose the bed: an original character and places you animate, or a video model with one prompt per beat** (`library`)
   Log each clip in ~/octopus-content/story/library/RIGHTS.md with the file, the model or "I made this", and the prompt. Do not rip a game, and do not name a commercial game or its characters in a prompt.
4. [ ] **Write four scripts that do not share a plot. First person, a start, a turn, an ending. Save each as script.md** (`four`)
   2,000 to 4,000 words is a planning range, assumed, unverified as a runtime.
5. [ ] **For each script write beats.md: every 20 to 40 seconds, the place, the motion, and the prompt or the library clip. Two videos do not share an order** (`beats`)
6. [ ] **Produce video one with the produce-one-video playbook. Upload only after rights.txt is complete** (`pilot`)
7. [ ] **Publish at most two a week for four weeks. If you cannot hold that, fix the bottleneck before you add volume** (`cadence`)
8. [ ] **When a listing is live, one sentence and the URL in the description. The story still has to stand if the link is ignored** (`shop`)
9. [ ] **Apply from Studio's Earn page only when that page says you meet a threshold, and only if the new videos are still original stories** (`ypp`)
   verified 2026-10-10 - https://www.youtube.com/creators/partner-program/
10. [ ] **If a video is a reading of someone else's post, or one loop with no scene changes, unlist it before you apply** (`kill`)
   A review looks at the channel, not only the newest upload. verified 2026-10-10 - https://support.google.com/youtube/answer/1311392

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
