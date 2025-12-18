# X-Profile-Metrics-Inline
Shows follower, following, joined year, and location inline on x.com timelines by scraping profile pages in background tabs using your logged-in session; results are cached locally. You will see tabs open and close in the background while you browse—this is expected and how the data is collected, and the amount of tab activity can be tuned in settings.

![Inline profile metrics on X timeline](assets/screenshots/x-profile-metrics-inline.png)

## Use it to shape your feed
A simple heuristic you can use: avoid following accounts with more than 1 million followers to keep the feed less generic and reduce what the algorithm pushes because “everyone else” follows it. The customizable color scale makes it easy to see what impact an account makes.

## What it does
- Adds a small inline line to each post with the selected fields.
- Colors **only the followers number** using your chosen color scale.
- Stores results in a local cache (Chrome extension storage) so repeated authors are fast.

## Install (unpacked)
1. Download and unzip the extension.
2. Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the unzipped folder.

## Options / Menu
Click the extension icon to open the settings (same page is used as the popup and the options page).

## Privacy
- All data stays on your device.
- The extension scrapes profile pages locally via your authenticated browser session.
- It does not send data to any server.

## Limitations
- X can change DOM/layout anytime; scraping may stop working until updated.
- If you’re rate-limited or profiles are not accessible from your account, entries may show as “-”.
- Fetching is triggered after you pause scrolling for ~0.5s (reduces wasted scrapes).
- Background tab scraping means you may briefly see extra tabs in the tab strip (created in the background).
