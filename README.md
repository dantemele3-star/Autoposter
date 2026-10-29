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

The fixes are maintained on the `fix/gameflip-listing-flow` branch. From your
existing GameflipApp folder, switch to it once:

```powershell
git fetch origin
git switch fix/gameflip-listing-flow
```

Close Autoposter before updating. Then double-click **Update-Autoposter.cmd** in
this folder to pull the latest changes, install dependencies, and start the app.
Git and Node.js must be available in your Windows PATH. The updater stops if a
step fails; it does not reset or discard local edits. If Git reports conflicting
local changes, resolve those changes before trying the update again.

You can also run the steps manually:

```powershell
git pull --ff-only
npm ci
npm start
```

Choose settings before starting; settings stay locked while a run is active.
Stop finishes the current item, including any required count maintenance, and
interrupts the wait before the next post.

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
Posting still waits 220–240 seconds between items, including continuous loops.

## Tests

```powershell
npm test
```

Tests launch an isolated headless browser and intercept all network requests with
local page fixtures. They cover the checkbox, competing profile/navigation
menus, delayed sorting, posting and deletion failures, single-tab actions,
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
