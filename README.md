# Timegate Overhaul

Timegate is a SCORM add-on that injects a timer overlay into a course and can optionally prevent the course from reporting completion until a minimum amount of time has been spent in the course.

Demo link: https://stephpayne.github.io/SIS-timegate/demo.html

In plain terms:

- it adds a visible timer to the course
- it tracks active time spent in the course
- it can delay SCORM completion reporting until the time requirement is met
- it does not lock the course UI or stop navigation

## What This Folder Is

This `timegate-overhaul` folder is the source package.

This is the version that should be stored in source control and shared with other people. If Timegate is copied into a specific SCORM package, that copied folder is just a working copy for that course.

Changes made here do not automatically update copied course folders.

## What Each File Does

- `timegate.js`
   Runtime logic for timer behavior, UI state, SCORM detection, completion interception, and persistence.

- `timegate.css`
   Styling for the timer overlay.

- `timegate.config.json`
   Course-level configuration.

- `install-timegate.ps1`
   Windows installer.

- `install-timegate.sh`
   Linux/macOS shell installer.

- `install-timegate.command`
   macOS-friendly wrapper for the shell installer.

## Quick Start

1. Unzip the SCORM package.
2. Copy the `timegate-overhaul/` folder into the SCORM root so it sits next to `imsmanifest.xml`.
3. Edit `timegate-overhaul/timegate.config.json`.
4. Run the installer from inside the copied `timegate-overhaul` folder.
5. Upload the generated `*-timegate.zip` to the LMS.

## Running The Installer

### Windows

From inside the copied `timegate-overhaul` folder:

```powershell
.\install-timegate.ps1
```

If PowerShell blocks script execution:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-timegate.ps1
```

### macOS

From inside the copied `timegate-overhaul` folder:

```sh
./install-timegate.command
```

or:

```sh
./install-timegate.sh
```

## What The Installer Does

The installer does three things:

1. Reads `imsmanifest.xml` to find the SCORM launch file.
2. Injects the Timegate CSS and JS into the launch HTML.
3. Adds the Timegate files to the manifest and builds a new `-timegate.zip`.

The installer does not overwrite the copied course config with values from this source folder. It uses whatever files are already present in the copied `timegate-overhaul` folder inside the course.

## Configuration

Edit `timegate-overhaul/timegate.config.json` in the copied course folder.

- `minRequiredMinutes` (number)
   The minimum number of minutes the learner must spend in the course.

- `enforceCompletion` (boolean)
   If `true`, Timegate blocks SCORM completion reporting until the minimum time is met. If `false`, the timer is informational only.

- `idleTimeoutSeconds` (number)
   Stops counting after this amount of inactivity.

- `backgroundGraceSeconds` (number)
   Keeps counting briefly after the learner leaves the course tab or window.

- `countWhileMediaPlaying` (boolean)
   If `true`, playing media can keep time counting even when the learner is otherwise idle.

- `hideWhenComplete` (boolean)
   Hides the overlay after the requirement is met.

- `position` (`bottom-right` | `bottom-left`)
   Controls overlay position.

- `debug` (boolean)
   Enables console logging for testing and troubleshooting.

- `storageMode` (`localStorage` | `suspend_data` | `dual`)
   Controls how timer state is stored.

## Fixed Runtime Behavior

The normal-state timer label and normal-state display mode are fixed by the runtime and are not intended to be publisher-edited.

That means:

- the normal label is fixed as `Time remaining`
- the normal display is fixed to show remaining time

If older copied course folders still contain `labelText` or `displayMode`, those are leftovers from older copies and are not part of the current source package.

## What `enforceCompletion` Actually Does

If `enforceCompletion` is on, Timegate delays SCORM completion reporting until the minimum time is met.

It does not:

- lock the course interface
- block navigation
- prevent learners from viewing content

It only affects what gets reported to the LMS.

## Persistence And Recommended Default

Timegate supports three persistence modes:

- `localStorage`
- `suspend_data`
- `dual`

Recommended default: `dual`

Why:

- `suspend_data` is the LMS-friendly portable option, but some courses already use most of the available SCORM suspend-data space.
- `localStorage` is reliable in the same browser on the same device, but it does not follow the learner across devices.
- `dual` writes to both and gives the best chance of resuming successfully.

How `dual` works:

- on save, Timegate writes to both `localStorage` and `suspend_data`
- on load, it prefers `suspend_data` and falls back to `localStorage` if needed
- if `suspend_data` is not readable early in SCORM initialization, localStorage can still restore the timer quickly

## Why Persistence Can Fail In Some Courses

The most common issue is that the course itself is already using most of the available `suspend_data` space.

If you see console messages like:

- `Suspend_data payload too large; skipping write`

that usually means the total combined SCORM `suspend_data` value is too large, not that Timegate alone is storing too much information.

This is why one course may work perfectly with `suspend_data` while another does not.

## Current UI Behavior

- The timer appears as a small overlay near the bottom corner.
- The paused state shows `Idle Timeout`.
- When the time requirement is met, the message reads: `Ensure you've completed all course content before exiting.`
- The close button is only visible in the completed state.

## Packaging And Testing Checklist

Before shipping a real course:

1. Make sure the course contains the latest copied version of `timegate-overhaul`.
2. Confirm `timegate.config.json` has the intended `minRequiredMinutes`.
3. Confirm `storageMode` is set as intended, usually `dual`.
4. Confirm `enforceCompletion` is set correctly.
5. Run the installer from the copied `timegate-overhaul` folder.
6. Upload the generated `-timegate.zip`, not the original course zip.
7. Do a smoke test in the LMS.

Suggested smoke test:

1. Launch the course.
2. Confirm the timer appears.
3. Confirm time increments.
4. Confirm the timer pauses when expected.
5. Close and reopen in the same browser.
6. Confirm the timer resumes.

If cross-device persistence matters, test that separately.

## Common Mistakes

- Editing the source package but forgetting to copy it into the course.
- Uploading the original course zip instead of the generated `*-timegate.zip`.
- Assuming rerunning the installer will replace a course's config file. It will not.
- Assuming replacing package files also clears LMS attempt data. It does not.
- Assuming replacing package files also clears browser localStorage. It does not.

## Troubleshooting

If the timer starts over after reopening:

- check `storageMode`
- check the browser console for persistence messages
- if `suspend_data` is too large, use `dual`

If the timer uses old progress unexpectedly:

- check whether the LMS attempt was reset
- check whether browser localStorage from a prior test is still present

If completion behavior is wrong:

- confirm `enforceCompletion` is set correctly
- test in the LMS, not only in a local unzip

## Maintenance Notes

If someone needs to update Timegate in the future, update the source package first:

- `timegate-overhaul/timegate.js`
- `timegate-overhaul/timegate.css`
- `timegate-overhaul/timegate.config.json`
- `timegate-overhaul/README.md`

Then copy the updated package into any course that needs it.

Copied course folders should not be treated as the long-term source unless they are deliberate one-off custom versions.

## Safe Summary For A New Owner

If someone inherits this package and only needs to use it, the safest process is:

1. Copy `timegate-overhaul` into the unzipped SCORM root.
2. Edit `timegate.config.json` in that copied folder.
3. Run the installer.
4. Upload the generated `-timegate.zip`.
5. Test one full launch and reopen cycle in the LMS.
