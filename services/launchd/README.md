# launchd template (not deployed)

`com.mo.icefox.plist` is the supervisor policy for the icefox agent. Copying it into `~/Library/LaunchAgents` and `launchctl bootstrap` are operator steps. This repository does not install it.

`KeepAlive` is a dictionary with `SuccessfulExit` false. launchd restarts the job when the process exits nonzero (a crash, including a signal death the parent maps to exit 1). It does not restart a successful exit.

A backend refusal is terminal. ViaProxy is up and the Minecraft backend refuses `127.0.0.1:25565` (`AnnotatedConnectException` / `finishConnect` / `error(-61)` / `Connection refused`). The agent, the parent, and `run-native.sh` (`exec node`, status unchanged) all exit 0 for that outcome, so this policy does not respawn it. The outcome is one loud `backend-unavailable` line. Exit 0 is required because launchd has no key that ignores one nonzero status and still restarts the others.

An explicit resume clears the in-process latch. Nothing here retries on a timer.

Do not set `KeepAlive` to true: that restarts exit 0 as well, which is the 1006-restart loop.
