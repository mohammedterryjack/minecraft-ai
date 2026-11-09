# launchd template (not deployed)

`com.mo.icefox.plist` is the supervisor policy for the icefox agent. Copying it into `~/Library/LaunchAgents` and `launchctl bootstrap` are operator steps. This repository does not install it.

`KeepAlive` is a dictionary with `SuccessfulExit` false. launchd restarts the job when the process exits nonzero (a crash, including a signal death the parent maps to exit 1). It does not restart a successful exit.

A backend refusal (`AnnotatedConnectException` / `finishConnect` / `error(-61)` plus `Connection refused`) does not exit 0. Exit 0 is a successful exit, and `SuccessfulExit` false does not restart it (launchd.plist(5): the job "will be restarted in the inverse condition"). The process stays up and `fs.watch`es `backend_log_dir` (the iMac value is `/Users/mohammedterry-jack/MinecraftServer/logs`). The first vanilla `Done (…s)!` line written after the refusal exits 75, `EX_TEMPFAIL` (sysexits(3): temporary failure, the user is invited to retry). That nonzero status is the single respawn. The same wait runs when a disconnect follows the server's `Stopping server` line, so a restart does not need a refused reconnect in between.

`authorizeBackendResume` runs once that Done line is in, then the process exits 75. Nothing here retries on a timer, and this plist is not edited. `KeepAlive` true is still forbidden: that restarts exit 0 as well, which is the 1006-restart loop. `WatchPaths` and `PathState` are not used.
