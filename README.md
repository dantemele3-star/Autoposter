# Gameflip Autoposter

Electron desktop app that copies saved Gameflip drafts into live listings using
Chrome. Requires Node.js 22.12 or newer and Chrome (or Puppeteer's bundled Chrome).

## Run on Windows

In PowerShell, from the folder containing this code:

```powershell
npm ci
npm start
```

The app finds Chrome in the standard Windows installation locations. Set
`CHROME_PATH` to the full executable path if Chrome is installed elsewhere.
Leave Hidden Mode unchecked when signing into Gameflip. Your existing
`AppData\Local\Gameflip_Ghost_Session` login profile is preserved.

## Get updates without patches

The maintained app is on the default `main` branch. Close Autoposter before
updating, then double-click **Update-Autoposter.cmd** to pull the latest changes,
install dependencies, and start the app. Git and Node.js must be available in
your Windows PATH. The updater stops if a step fails; it does not reset or
discard local edits.

Repository history was rewritten to remove committed credentials and browser
data. An older checkout cannot update normally with `git pull --ff-only`.
Close the app and clone a fresh copy into a new folder once:

```powershell
cd "$env:USERPROFILE\Desktop"
git clone https://github.com/dantemele3-star/Autoposter.git GameflipApp-clean
cd GameflipApp-clean
.\Update-Autoposter.cmd
```

Keep any personal files from the old folder locally. Do not copy its `.git`,
`.env`, or browser-cache folders into the fresh clone or push old branches back
to GitHub. The app's Windows login profile remains outside the checkout in
`AppData\Local\Gameflip_Ghost_Session`.

You can also run the steps manually:

```powershell
git pull --ff-only
npm ci
npm start
```

Choose settings before starting; settings stay locked while a run is active.
Stop finishes the current item, including any required count maintenance, and
interrupts the wait before the next post.

## Scan and select drafts

Each cycle scans `/listings/draft?page=1&limit=50`, page 2, and subsequent
pages before randomizing or posting. A full page is followed even if Gameflip's
Next control is not recognized. The log prints **Scan complete** with the total
number of unique drafts before posting begins. Repeated pages or failed requests
pause the run rather than post from an incomplete scan.

Drafts are identified by their listing IDs or unique copy links. If creating a
copy shifts the rows or moves a draft to another page, the app locates the
original draft again instead of clicking its old row number. Newly appearing
drafts are picked up in the next cycle. The log names the copy, Done, preview,
and submission steps so a timeout identifies which step failed.

## Maintain listing count

With **Delete Oldest Listing** checked, the app verifies that the new listing was
published, opens On Sale, selects **Created: Oldest**, and opens the oldest
individual listing. It uses that listing's action menu and confirmation dialog,
then refreshes On Sale to check that the listing disappeared. It never falls
back to deleting the first unsorted item and does not delete the newly posted
listing when it is the only one available.

If posting, sorting, or deletion cannot be confirmed, the run pauses with an
error. Check Gameflip before restarting after an uncertain publication, to avoid
posting a duplicate. The pointer is moved out of the header before actions, and
profile menus and section navigation links are excluded from deletion targets.
## Timing and posting limits

Navigation and clicks are separated by at least two seconds after the previous
action completes. Controls must also be ready before they are clicked. After
List Item, the app allows a 90-second confirmation window and checks On Sale by
the copied listing's ID, including subsequent pages. A List Item button on the
On Sale page does not prevent confirmation. Verification only reads pages; it
does not click List Item again.

There is a minimum 220-second cooldown after a submission and its verification
or count maintenance finish. Stop, restart, and continuous loops preserve that
cooldown. A single-instance lock prevents a second copy of the app running at
the same time.

The app caps its recorded submissions at 400 in a rolling 24-hour period. An
attempt is recorded before the submit click, so a post with an uncertain outcome
still consumes a slot. A crash during confirmation keeps a longer provisional
cooldown. The run pauses at the daily cap. An unreadable history pauses posting
instead of resetting the counter.

History is stored in `posting-history.json` in Electron's user-data folder
(`%APPDATA%\gameflip-poster` on Windows), outside the Git checkout. Updates do not
replace it. Tracking starts with this version: older submissions, manual posts,
and posts through other clients are not counted. This is an app limit, not a
reading of your account's remaining Gameflip quota. Keep enough room for those
other posts and follow Gameflip's account limits.

## Tests

```powershell
npm test
```

Tests launch an isolated headless browser and intercept all network requests with
local page fixtures. They cover the checkbox, competing profile/navigation
menus, multi-page draft scanning, shifted row positions, consecutive posts,
delayed indexing, On Sale confirmation, paced clicks, persistent cooldowns,
the 400-submission cap, delayed sorting, posting and deletion failures, single-tab actions,
overlapping runs, stopping, and loop rate limiting. They do not use your login
profile or create/delete real Gameflip listings. The live site's current markup
and the Windows desktop interaction still need checking on your PC.

For the prepared Linux cloud checkout (which already has system Chromium):

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
CI=1 CHROME_PATH=/usr/bin/chromium npm test
```

Normal Electron startup requires a graphical desktop. The cloud tests validate
the browser automation and GUI event handling without a Windows desktop session.

## Keep account data local

The app uses your Chrome login session; it does not need API keys or an `.env`
file. Browser profiles, environment files, generated listing logs, and build
outputs are excluded from Git. Revoke any Gameflip API credentials committed in
the old history. Removing files from history does not revoke credentials or erase
copies in other clones, forks, or GitHub caches.

The unused API client dependencies, duplicate entry file, old renderer, generated
listing log, and nonworking packaging command/configuration have been removed.
This repository supports running from source with `npm start` and checking with
`npm test`; portable installer packaging is not configured.
