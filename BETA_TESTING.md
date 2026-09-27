# PULSE v0.9 Beta Test Plan

## Beta goal
Validate that PULSE reliably tracks substances, schedules, completed/skipped doses, inventory, cycles, adherence, and notifications on real mobile devices without manual database intervention.

PULSE is a tracking and reminder tool. It does not prescribe, recommend, or determine dosing or medical treatment.

## Required device coverage
- iPhone/iPad installed to Home Screen
- Android installed as a PWA
- At least one desktop browser sanity check

## Core end-to-end scenario
1. Create an account and confirm/sign in.
2. Add a substance with category, form, route, dose and unit.
3. Add inventory with concentration/strength, quantity on hand, low-stock threshold, and optional expiration.
4. Add a recurring schedule.
5. Enable background push notifications.
6. Confirm the scheduled dose appears in Today.
7. Log the dose.
8. For injectables, select an injection site.
9. Verify the log appears in History.
10. Verify adherence updates.
11. Verify inventory decrements when configured.
12. Put the substance into a cycle.
13. Verify Substance Details and Cycle Details reflect the new activity.
14. Export PULSE data from Settings & Data.

## Notification checks
- Due-soon push arrives within the configured lead window.
- Overdue push arrives after a scheduled dose remains unresolved.
- Low-stock/expired inventory push arrives.
- Reopening from a notification opens PULSE.
- A single event does not generate repeated duplicate notifications.

## Data integrity checks
- Editing a schedule does not rewrite historical logs.
- Editing a substance does not delete history.
- Archiving a substance disables its active schedules.
- Restoring a substance does not unexpectedly reactivate old schedules.
- Deleting a history entry causes the scheduled occurrence to become unresolved again where applicable.
- Inventory never becomes negative.
- Supply estimates only appear when units/concentration support a valid calculation.
- Cycle deletion does not delete dose history.
- Export includes substances, schedules, logs, inventory, cycles, cycle membership and notification preferences.
- Delete all tracking data removes tracking data while leaving the login account usable.

## Account checks
- Sign up
- Sign in
- Sign out
- Password reset from the signed-out screen
- Password reset while signed in
- Session recovery after closing/reopening the PWA
- Graceful retry of transient JWT clock-skew errors

## PWA checks
- Installs without requiring repo/developer steps.
- Launches in standalone mode.
- App icon/branding display correctly.
- Updating PULSE does not require deleting/reinstalling the app.
- Modals, forms and keyboards remain usable on small screens.

## Beta feedback format
For every bug, record:
- Device/model
- OS version
- Browser/PWA
- What you were doing
- Expected result
- Actual result
- Screenshot or screen recording when useful
- Approximate local time of the failure

## Release gate
A build can be promoted beyond private beta only when:
- CI is green.
- No known data-loss bug exists.
- No authentication blocker exists.
- No duplicate-log blocker exists.
- No known negative-inventory path exists.
- Background notifications are verified on both iOS PWA and Android PWA.
- Core end-to-end scenario passes on both platforms.
