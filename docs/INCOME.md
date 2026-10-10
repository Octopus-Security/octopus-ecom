# Online income

Where each way of making money online sits. The shop is the part this app operates. Everything else is a checklist a person follows, or a thing this estate does in another repo. The order that can pay is the `estate-income-order` playbook. This file is the map.

Video files do not live in this repo. Pushing `main` deploys the shop. Working files go in `~/octopus-content/`. See that folder's README.

None of this is a promise of revenue. A million dollars of profit is the stack below, added up over years, if the offers actually sell. The next 90 days are ten shop sales, one repeatable video, and one kit with a price.

## Order

1. **Shop cash.** One original product, dry-run, then live when you mean to charge a buyer. Etsy through this app. The same design on Redbubble, uploaded by you.
2. **The blog clock.** `octopus-blog/MONETIZATION.md` in the checkout you have. When this map was written, that copy said an Amazon Associates account was open, the 180-day / 3-sale clock was running, and the tag in the posts was still a placeholder. Display ads want posts before an application. Re-read the file before you act on that sentence.
3. **Videos that sell the shop.** A channel does not need ads turned on to put a live listing URL in the description.
4. **A kit you sell by hand.** The story playbook, cleaned of anything private, as a zip. This app does not host the file.
5. **YouTube ads.** After the thresholds on the creators page, and after a review. Not this month's rent.

## What this app operates

| Way | Status | Where to work |
|---|---|---|
| Original designs, print-on-demand, sold on Etsy | Built. Never run against a live shop. Dry-run is the default. | `launch-pod-etsy`, then arm live writes only on purpose |
| The same designs on Redbubble | Built as a pack and a checklist. You upload. | `redbubble-revive`, `redbubble-publish`, `redbubble-game-plan`, `redbubble-weekly` |
| Fees, refunds, NET | Built for Etsy sales the app ingests, and for Redbubble lines you import | Sales tab. NET is operational, not a tax return |
| Ideas for the next design | Built. Approval creates an idea card, not a listing | `weekly-proposals`, `weekly-trend-review` |

## What a person does, with a playbook here

| Way | Pays when | Playbook |
|---|---|---|
| Long-form original fiction. The bed is moving-background style: your own design, or a video model whose clips follow the beats | Ad revenue only after the partner-program review. Before that, a link to a live listing | `faceless-story-channel`, `produce-one-video` |
| One YouTube channel per niche, on the Google account you already have | Separate audiences. Not a spare account for a strike | `youtube-niche-channels` |
| Short videos that show one live product | When someone buys. Ads are a later extra | `niche-shop-traffic` |
| One teaching channel, a topic you have actually done | Same partner-program door as the story channel. One product link after the answer | `niche-explainers` |
| A Short cut from a video you already made | A click to the long video or the listing. Shorts views do not add long-form watch hours | `niche-shorts` |
| Selling the written kit | When someone buys the file. No watch hours | `niche-digital-kit` |
| A weekly hour that records dollars, claims, and the one next piece of work | It stops you feeding a channel that is not paying | `weekly-content` |

The story bed is the moving-background style: a character or camera travelling through places while one story is told. Make that as your own design, or generate one clip per beat with a video model and keep the prompt. Do not rip a game, and do not ask a model to recreate one. The shop's image generator makes print designs. It does not make these clips. Readings of other people's posts are out too: YouTube's monetization policy, read 2026-10-10, treats readings of website text as reused content, permission or not. The playbook has the cites.

## Documented, not built

Do these by hand, or not at all, until there is a playbook and a reason.

| Way | Notes |
|---|---|
| TeePublic, Amazon Merch, a Printify pop-up store | Same artwork as Etsy. Another manual channel, like Redbubble. Not built. |
| Etsy digital file, Gumroad, Payhip | How the kit gets sold. Read that site's terms the day you list. No adapter here. |
| Affiliate link to your own listing | The shop-traffic description. Disclose that you sell it. |
| Other affiliate programs | Only a program you joined, on a page that says so. The blog already has an Associates checklist. Do not invent tags. |
| Brand deal or sponsorship | After a channel has an audience a sponsor can look at. Say it is paid. YouTube's paid-promotion control is on the upload form; its exact wording was not re-read for this map. |
| Channel memberships, Super Chat, Super Thanks | The lower partner-program tier. See the story playbook for the numbers read on 2026-10-10. |
| Email list | octopus-edm is a separate repo. A list is worth building after something exists to mail about (a listing, a kit). Not wired to this app. |
| Pinterest pins of your own products | You pin them. This app does not call Pinterest. |
| TikTok, Instagram, or another short-video app | The same Short you already cut, uploaded by you, under that app's rules. Their funds were not read for this map. Do not re-upload other people's clips. |
| Stock or a license of an original design | Later, from art you can prove you made. |
| A printed book or a KDP book | Only a book you wrote. A mill of generated books is the same template problem as a mill of videos, and KDP's rules were not read for this map. |
| Freelance or a paid video for someone else | The produce-one-video path is the craft. Charge a fee you write down. Disclose the relationship if their product appears on your channel. |
| A course | The kit, plus proof. Do not record a course before ten people have used the checklist. |

## Estate services

A service earns when a stranger can pay for it and the price is public. This map does not assign a price to cortex, auth, or the other repos. If one of them has a payer, that revenue is real and belongs in the weekly note. If it does not, it is not income yet.

## Where a new tool goes

Your money first. A tool other people can use waits until you say so, and until you are being paid.

The estate rules for that:

- The Discord bot in cortex is the owner remote. It already refuses every Discord account except `DISCORD_USER_ID`. The public cortex image strips the bot. A command that spends money or changes a stack stays on the bot's existing 2FA list.
- A new process gets its own repo, its own secret, and a `hub.json` with `"access": "private"` and its own subdomain, the way this shop is `ecom.octopustechnology.net`. It does not share a process with the bot, a shell, or another person's keys.
- This pass did not add a subdomain. The checklists are in the shop you already have. A content app is a later process, still private, and only if the folder-and-playbook path is actually in the way.

## Out of scope

These are not on the list, and no playbook will grow a step for them:

- Bought views, subscribers, or engagement
- A second account whose purpose is to replace one YouTube punished
- Ripped games, movies, music, or another creator's video
- Reading scraped posts as the product
- Counterfeit or branded goods
- An AI character giving medical, legal, or financial advice
- Generic dropshipping onto Etsy (the `dropshipping` playbook says why)

## Paths

| Path | What it is |
|---|---|
| `docs/INCOME.md` | This map |
| `docs/playbooks/` | Rendered checklists. Edit `server/playbooks/definitions.js`, then `node server/playbooks/render-md.js` |
| `docs/COMPLIANCE.md` section 9 | What was read on YouTube's own pages, and the date |
| `~/octopus-content/CHANNELS.md` | Your channel URLs, and nothing about the Google login |
| `~/octopus-content/story/<yyyy-mm-dd-slug>/` | One story video: script, beats, voice, rights, export |
| `~/octopus-content/story/library/RIGHTS.md` | The motion clips you own |
| `~/octopus-content/shop/` | Product videos and `LOG.md` |
| `~/octopus-content/explainers/` | The teaching channel, after the first two exist |
| `~/octopus-content/kits/story-channel/` | The cleaned zip you can sell |

## 90 days

Write these four lines on day 90. Keep what is non-zero. Stop what took the hours and returned nothing.

- Shop orders, and NET
- Public videos, and whether any description click became a session
- Kit: listed or not, sales, the questions buyers asked
- Hours
