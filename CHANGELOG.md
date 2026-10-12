# Changelog

## 1.7.0

- **Run the server without Cloudflare:** the same server runs with Docker or Node.js, with its data in one SQLite file (a VPS, a home server, Railway, Fly.io, InstaCloud). `docker compose up -d` in `worker/`; guide in [docs/self-hosting.md](docs/self-hosting.md). On such a server the app shows how to update or remove it instead of the Cloudflare buttons.
- **Why a computer went silent:** the tracker records when and why it couldn't reach the server (no internet, refused on this computer, a different server answered, a proxy or firewall, DNS blocked), hosts-file edits with their lines and time, DNS blocks, a proxy in use, removed hooks or background check-in (put back), and pause/resume. The admin sees them as badges and an **Events** list under Devices, with a reason next to a silent computer, and gets a notification when tracking is blocked or removed. `devicetally status` shows an ongoing outage.
- When this computer's lookup gives the server an address that refuses, the tracker also tries 1.1.1.1's answer (the certificate is still checked).
- Overview hints at a computer that is online on a weekday afternoon but has no usage today, though it normally has plenty.

## 1.6.3

- **Blocking the server in the hosts file no longer stops tracking:** when a computer's own lookup sends the server's address nowhere (a line like `0.0.0.0 your-server` in /etc/hosts), the tracker and the app ask Cloudflare's DNS (1.1.1.1, over HTTPS) for the real address. The server's certificate is still checked.
- **The admin sees it:** Devices shows "DeviceTally blocked in the hosts file", and Overview lists it; `devicetally status` says so on that computer.
- **Updates are automatic by default** on every computer (installed when DeviceTally isn't in use, then it says so). The admin can choose "Ask the user" for all or per computer.
- Sessions explains that it lists Claude Code sessions for now, and where other tools' usage is.

## 1.6.2

- **Linux updates work for .deb installs:** the update file now names the .deb for .deb installs and the AppImage for AppImage installs (a .deb install was offered the AppImage: "invalid updater binary format"). Computers on an older version install 1.6.2 by hand once.

## 1.6.1

- **Updates show what's happening:** checking shows a spinner and the seconds (gives up after 30 s with a clear reason); updating shows the download in MB with a bar, then Installing and Restarting.
- **Copy details:** if a check or an update fails, one click copies a short log (versions, steps, the exact error) to send to the admin. A failed automatic update is also shown in Settings → App.
- **The menu bar starts readable after updating:** fixed colours are cleared once (an item in a fixed colour could vanish against the menu bar), normal size and spacing, and at least two items show.
- **Agent status when done:** a new **Burst** (a dot with eight rays), next to Dot and Spark.

## 1.6.0

- **Joining takes seconds:** a computer says it's connected right away and uploads its history in the background (it used to sit on "Connecting..." for many minutes on computers with a lot of history).
- **Joining again is safe:** the same computer keeps its device, history and sessions (no duplicates in Devices); a computer joining a different server uploads its whole history there; an account you ignored stays ignored.
- **Computers stay online with the app closed:** the tracker checks in every 5 minutes on Mac, Linux and Windows and says whether the app runs. Devices shows "Online · app closed", and a red "isn't reporting" when a computer goes quiet. The 5-minute job reinstalls itself if the system removes it.
- **Open at login** is required on joined computers (locked in Settings) and on by default elsewhere. Only one DeviceTally runs at a time.
- **When the server is down** (offline, or Cloudflare's free limit): clear messages saying what happened and when it's back, and each computer shows its own count, menu bar included.
- **Server 1.0.4** (Settings → Server → Update server): far fewer database reads (it hit Cloudflare's free daily limit once), the free-limit pause explained, merged health reports, safe re-joining.
- **Prompts:** open any prompt in full.
- **Projects:** Claude Code agent worktrees and subfolders of repos without a remote count as their repo (they showed as "agent-…").
- **Agent status when done:** a closed ring with a check, a dot or a spark.
- **Linux:** live text next to the tray icon, a Menu bar tab that fits Linux, Linux cache locations and the Trash in Storage; tested on Ubuntu 22.04/24.04, Debian 12 and Arch.
- In a full-screen app, the window opens on a regular desktop like other apps.
- `devicetally status` shows hooks, the check-in job and whether the app runs.

## 1.5.0

- **Just this computer:** use DeviceTally with no server and no account. Your AI usage (Claude Code, Codex, OpenCode, Kimi), agent status, menu bar and storage, counted on this computer; nothing leaves it. Connect to a server later and the history uploads.
- **Updates that reach you:** a new version shows a card with **Update now** / **Later**, or installs itself when DeviceTally isn't in use (**Update automatically**, Settings), then says so.
- **Admins:** each computer's version on Devices, marked when it's behind; updates per computer (ask or automatic) with a default for all; **Update now** for one computer (within about 5 minutes); and a note when a computer couldn't update (e.g. no permission to install apps).
- **Menu bar:** separate items sit together (DeviceTally sets macOS's gap between its own items to 0; other apps are unaffected), so **Between items** is the whole gap. The preview matches.
- **Main window:** the logo, name and version stand out; **Today** in the ranges; the devices table has one tokens column with a Today / 7 days / 30 days picker.
- **Menu-bar panel:** name and version on top, then Open DeviceTally, Settings and Quit.
- Device notices are one quiet line each.
- **`npm run try`** runs the app locally with live reload (marked TEST) before a release.

## 1.4.2

- Device notices (offline, tracking problems, disk filling up) are quiet rows with a short title, not red boxes, and say "Last seen a day ago" instead of "1 days".

## 1.4.1

- 1.4.0 for Windows and Linux (1.4.0 didn't build there).

## 1.4.0

- **Separate menu-bar items sit tight:** each is as wide as what it shows (with digits as 8, so it doesn't jump), and Spacing at 0 really means almost touching. Before, each item kept room for its widest possible value plus fixed margins.
- **One combined item no longer drops items at the end:** it had a hidden 360 pt limit. Maximum width is now "No limit" unless you set one.
- **Colours match the real menu bar:** text without its own colour follows the menu bar's actual look (which also depends on the wallpaper), not just dark mode, so it's never black on a dark menu bar.
- **The preview matches the menu bar:** separate items are shown edge to edge, as they are, and Light/Dark starts from how your menu bar looks.
- **Drag to reorder works:** drag an item's grip (⋮⋮) in the list.
- **Themes are gone;** everything they set is still under General and each item. **Reset to the default look** (General) undoes a theme and keeps your items.
- **Quit** button in the popover, next to Settings. Tracking keeps working when the app is closed.
- Fixed: the prompts list looked broken when a prompt started with an editor note (a style clash with the notification card).
- Network panel: the Connected dot is green, and the chart colours match Download and Upload.

## 1.3.0

- **Network panel like Stats:** upload and download history in one mirrored chart, a connectivity grid with latency and jitter, totals with a reset button, interface, MAC address, local and public IP (with country and provider), DNS, and the apps using the network right now.
- **Agents panel:** what each agent is working on (the prompt) with a live timer, what needs you, and a history of finished tasks with how long each took; today's count and agent time at the top.
- **Agent status looks:** while working, a comet ring, a breathing pulse or wave dots; when done, a badge, a seal or a plain check (Menu bar → Agent status → Look).
- **Battery charger animation:** with the percentage inside the icon, plugging in fills the battery up and pops the bolt in; unplugging fades the bolt out.
- **Themes for the menu bar:** Clean, Stats, Colourful, Terminal and Icons, as one-click starting points (Menu bar → General).
- **Tighter spacing for separate items:** macOS's own padding is gone, so Spacing controls the whole gap.
- **Clock:** digital or analog (the icon alone), never both; its own spacing between the date and time parts.
- **My usage shows everything** for your computer: by tool (with logos), by model, cost and replies, plus a tool filter.
- **Storage:** a new design (disk bar by category, what's safe to clean, size bars). No more permission pop-ups: without Full Disk Access it skips folders macOS asks about; give it Full Disk Access once to scan everything.
- **Dock:** clicking DeviceTally in the Dock opens its window; "Hide from the Dock" (on by default) in the first screen and Settings.
- The main window opens larger, and its tabs stay on one line.
- Fixed: the battery colour didn't apply in the "In icon" style, and Large/Max didn't make that icon bigger.

## 1.2.2

- **"Finished" notifications say which prompt is done:** "Claude Code finished · devicetally — Done: “fix the menu bar freeze” · took 3 min". The prompt's start stays on your computer.
- **The disk-full notification is off by default.** It came at every start on a full disk and looked like an agent notification. Turn it on under Menu bar → Disk.
- **The working ring turns smoothly** (15° steps, 12 times a second, instead of 45° steps 4 times a second), and only the ring is redrawn between updates.
- **Spacing works with separate items too:** Menu bar → General → Spacing adds room on both sides of every item.

## 1.2.1

- **Fixed: adding or removing a menu-bar item could freeze DeviceTally** (it had to be force-quit). All menu-bar changes now happen one at a time on the app's main thread.
- **Fixed: making one item large shrank the others.** Large items are now shown at the menu bar's full height, and each item keeps its own size.
- **Fixed: Agent status could stay idle while an agent was working.** The tracker used by Claude Code's hooks was only updated by its own daily check, so after an app update it could stay old. DeviceTally now updates it on start.
- Network panel: total upload and download.

## 1.2.0

- **Menu bar settings redesigned:** a live, clickable preview of your menu bar (light or dark), item tiles, one-click size presets, drag to reorder, and each item's options grouped in cards.
- **Any size from 50% to 200%,** for all items or one; large sizes use the menu bar's full height and the agent ring grows with them.
- **Agent alerts live in Agent status;** the separate Alerts page is gone.
- **"Send a test" always shows something:** macOS blocks system notifications for apps without a paid Apple signature, so DeviceTally shows its own notification in the top-right corner (click it to open DeviceTally).
- Cleaner Safe / Caution / Risky tags in Storage, a softer selected row in the sidebar, button labels without "…", and a larger Settings button.
- Lock this computer leaves Claude Code's transcript cleanup as it is.

## 1.1.0

- **A menu-bar item per module, like Stats:** Agent status, Network, CPU, Memory, Disk, Battery and Clock are separate items, and each opens its own panel over any app: Network shows speeds with live graphs and your connection; CPU shows usage, temperature and top processes; Memory, Disk (with "What's using space?"), Battery (health, cycles, time left), Clock (calendar) and Agents. **Combine into one item** (Menu bar → General) brings back a single item with everything.
- **First launch is simple:** three items (Agent status, Network, CPU temperature) at a normal size, in the menu bar's own colour. The agent ring tells its states apart by shape; state colours are a switch away.
- **Open DeviceTally comes to the desktop you're on** instead of switching you back to the one where it was opened before.
- Delete DeviceTally button: cleaner label.
- **Storage scan no longer triggers macOS permission pop-ups:** it skips other apps' private data (Containers, Mail, Messages, Safari…). Desktop, Documents and Downloads are included only if you tick the box (macOS asks once for each). Faster too.

## 1.0.3

- Joining a computer just says "✓ <name> is connected. Monitoring is on."
- DeviceTally is described as what it is: one menu-bar app for all your computers (AI coding usage, agent status, system monitor, storage, device health).

## 1.0.2

- Joining a computer says what it tracks (e.g. "Tracking: Codex, OpenCode"), notes other AI tools found, and mentions Claude Code only as a note when no account is signed in. A computer without Claude Code is fully supported.
- Running the join command again on a connected computer says "already connected" instead of an error; a used or expired code gets a clear explanation.

## 1.0.1

- **Menu bar tab, like Stats:** a sidebar with icons and on/off switches on the left; the selected item's settings and the live preview on the right, at any window width.
- **Agent status ring:** compact and recognisable at a glance: an orange ring that turns while an agent works, a red ! when it needs you, a green ✓ when it's done, grey when idle. Optional short word beside it. Replaces the pill.
- The menu bar redraws 4 times a second only while an agent is working (the ring turns); system counters are still read every 2 s.

## 1.0.0

The first stable release.

- **Usage across all your computers:** Claude Code in detail (tokens by type, model, project and session; cost matches ccusage), plus Codex, OpenCode and Kimi token totals.
- **Your own server, free:** the app creates it in your Cloudflare account. No one else holds your data.
- **Menu bar you design:** agent status, tokens today, network, CPU, CPU temperature, memory, disk, battery (also with the percentage inside the icon) and clock; per-item label, layout, size and colour; 12 fonts; live preview.
- **Agent status and alerts:** know when Claude Code is working, needs you, or is done (Codex: done), with optional Mac notifications and sounds.
- **Admin dashboard:** Overview with a daily chart by device, Sessions, Devices with health (online, locked, tracking problems, disk forecast), allowed projects, prompts with filters.
- **Storage:** what AI tools, developer caches and big folders use, with Show in Finder and Move to Bin for caches.
- **Lock this computer** (macOS): tracking in Claude Code's system-wide settings, so it can't be turned off without an administrator.
- **In-app updates,** signed and verified before installing.
