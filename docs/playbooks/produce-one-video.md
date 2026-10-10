# Produce one video: folders, rights, upload

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** A script is ready and you are making the file you will upload.

Video files do not go in this repo. Pushing main deploys the shop.

PATH. ~/octopus-content/<channel>/<yyyy-mm-dd-slug>/
- script.md, the words that are spoken and nothing else
- beats.md, time ranges, what is on screen, and the prompt if a model made the clip
- voice.wav, the narration
- captions.srt, the same words as the voice
- footage/, clips already named in the library rights file
- project/, the editor project. CapCut, DaVinci, or whatever you already use. This app does not drive it and does not upload
- thumbnail.png, 1280x720, a moment from the story or the product. No game logo
- upload.txt, title, description, tags, shop URL or the word NONE, and whether the voice or a face is synthetic
- rights.txt, script, voice, music, footage, each with a source

Export 1920x1080, or 2560x1440 if the export is cheap for you. A 9:16 Short is cut later from this master (niche-shorts), not a second shoot.

VOICE. Your own voice is the simplest license. A synthetic voice needs a commercial license that covers advertising, and the altered-or-synthetic control on the upload form set to match. The control's exact label is assumed, unverified; read the form in front of you. Do not clone a voice that is not yours.

MUSIC. YouTube's audio library, or a track whose license you can paste into rights.txt. No commercial songs and no sped-up copies of them.

PICTURE. Cut on the beats. Captions on. The conflict is in the first 15 seconds, then the story. The bed keeps moving, and it changes when the story changes: a new place, a new action, a new generated clip. Do not open on silent footage. A loop with no words is the reused-footage case, not a story. A generated clip's prompt names the place and the motion in your own words. It does not name a commercial game or describe that game's characters. The model name and the prompt go in rights.txt. This shop does not generate the clip for you.

TITLE. Name the situation. Do not put "Reddit" in it and do not put a game's name in it. The game's name is a trademark you do not own, and it promises a video you are not making.

## Steps

1. [ ] **Create the slug folder and an empty rights.txt before you record** (`folder`)
2. [ ] **Read script.md aloud once, cut any sentence that only stalls, and confirm you wrote it or paid for it** (`script`)
3. [ ] **Record or render voice.wav. If the voice is synthetic, write the product name and the license in rights.txt** (`voice`)
4. [ ] **Lock beats.md so every 30 seconds names a picture. No stretch longer than 45 seconds on one unchanged loop** (`beats`)
5. [ ] **Edit in project/, export, watch the export once at 1.5x, and fix the one dead stretch** (`edit`)
6. [ ] **captions.srt matches the voice. Burn them in or upload the sidecar. They exist either way** (`captions`)
7. [ ] **thumbnail.png is a story moment or the product, plus the title's key words. No game logo, no celebrity face** (`thumb`)
8. [ ] **Write upload.txt: title, two-sentence description, shop URL or NONE, situation tags rather than brand tags, synthetic yes or no** (`upload-txt`)
   Title length limits change. If Studio warns, shorten it. assumed, unverified that 70 characters is still a safe planning cap.
9. [ ] **rights.txt has no blank source. If one is blank, do not upload** (`rights`)
10. [ ] **Upload yourself in Studio on the correct channel, set the disclosure to match upload.txt, and paste the video URL back into upload.txt** (`upload`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
