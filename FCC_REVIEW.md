# Review pass for Lucid Reader (fcc-mode). This file is run 5 times, each in a fresh session.

No mannered prose. Answer first, short sentences, numbers and names, end on the result.

You did not write this code. Assume it has bugs. Your job: find them, fix them, prove the fixes.

Read FCC_TASK.md and FCC_TASK2.md (the owner's requirements) and HANDOFF.md (what the builder claims). Check every item in both task files, including the Flow "line jump" measurement in FCC_TASK2.md section C. Then:

1. Back up: `cp -R ~/pdf-reader ~/code-backups/pdf-reader-review$PASS-$(date +%H%M)` (PASS is in REVIEW_PASS.txt).
2. Check every requirement in FCC_TASK.md yourself with a measurement, not by reading the claim. Record each as PASS or FAIL with the number you measured.
   - Flow: in headless Chromium (Playwright), open a real PDF, start Flow at 250 wpm, sample the current line's viewport top every 200 ms for 5 s. Pass if it moves under 2 px and the page scrolled over 50 px.
   - First sentence: getComputedStyle(.sn.fs).fontWeight >= 600 by default.
   - Corner labels: zero visible ".pagemark" text, and no repeated title/page-number lines in the first 30 pages of ~/Calibre\ Library/*/*/*.pdf (pick one book).
   - Pages: in paginated mode, for 20 page turns, no line box is cut by the page bottom.
   - Settings: every SETTINGS entry has a label; every select/range has a hint or self-explanatory label; panel renders with zero console errors.
3. Security checks (all must hold):
   - No network requests except the PDF itself and extension files (check with Playwright request log).
   - No eval, new Function, inline event handlers, or remote script URLs (grep reader/ options/ background.js).
   - Every innerHTML write uses escaped text (grep innerHTML; check each one).
   - manifest.json permissions unchanged from: storage, declarativeNetRequest, contextMenus; host_permissions <all_urls> only.
   - Links from PDFs open with rel="noopener noreferrer"; only http(s)/mailto/#page= hrefs allowed (javascript: must be rejected; add a unit test).
4. Run `node --test test/*.test.mjs`; all must pass. Load the reader page with 3 different PDFs (book, Efficiency_Loop_All_Ideas_Scored.pdf, tax-f8886/i8886.pdf); zero console errors each.
5. Fix every FAIL. Re-measure after fixing.
6. Append to REVIEW_LOG.md: pass number, time, each check PASS/FAIL with numbers, what you fixed. Then print REVIEW_DONE.

Never touch ~/free-claude-code, ~/.fcc, any .env, or anything outside ~/pdf-reader except backups and /tmp.
