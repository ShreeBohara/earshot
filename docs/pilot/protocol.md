# The review pilot: protocol

How to run one session of the five-person pilot. The measures and the analysis are fixed in `docs/pilot/pre-registration.md`; nothing here changes them.

## Before the first session
- Fill in the pre-registration's three blanks (the commit, the set's SHA-256, and the reporting decision) and commit them.
- Check out that commit, and run the pilot page locally: `pnpm dev` in `apps/web`, then open `http://localhost:3000/pilot`. It's a static page with no account and no server writes, so no deploy is needed.
- Give each participant the next number, P1 to P5, in the order they come. Never reuse a number.

## Setup
- A laptop with a current Chrome, plugged in, with notifications off and nothing else open.
- Open `/pilot?p=N` for participant N in a fresh window.
- The participant sits at the laptop on their own. You stay nearby, out of view of the screen.

## What you say
Read this, and nothing more about the cards:

> This tests the software, not you. You'll review some proposed CRM changes from sales calls. Review these as if they were your own. It takes about half an hour, and you can stop at any time.

During the session, don't hint, point, or explain the cards or their markers. If asked about a card, say: "Do whatever you'd do if it were yours." Technical problems are the exception: help with those, and note them.

## During
The page walks through consent, then the practice cards, then the 40 cards. Write down anything unusual, such as an interruption, a reload, or a question about a card. These go in the report's deviations.

## Afterwards
- The participant chooses "Download results" and gives you the file, named `earshot-pilot-<participant>-<date>.json`. Check that it opens.
- Keep result files in a private folder outside the repository. Never commit them.
- Close the window. The page keeps nothing once the tab is closed.

## Withdrawal
If a participant withdraws, delete their file and every copy of it, tell them when it's done, and leave their number unused. Their session is reported only as withdrawn.

## After all five
Run `pilot:analyze` on the five files, as the pre-registration says, and report the results with every deviation.
