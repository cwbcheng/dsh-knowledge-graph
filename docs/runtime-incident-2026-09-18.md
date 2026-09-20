# DSH connection-loss incident (2026-09-18)

## Evidence

- Port 3099 had no listener; the previously started Node PID 553058 was gone.
- WSL recorded SIGSEGV for `/opt/node-v24.14.0/bin/node`, PID 553058.
- Preserved core: `C:/Users/Dave/AppData/Local/Temp/wsl-crashes/wsl-crash-1789664679-553058-_opt_node-v24.14.0_bin_node-11.dmp`.
- Core PC `0x7ed5e5ed5df5` maps to Node text address `0x1aa3df5`,
  `Builtins_RegExpPrototypeTestFast + 1205`. This identifies the crash site,
  not the origin of the invalid pointer or a proven V8 defect.
- Separate Python and .NET native crashes also appear in the WSL kernel log.
  A common platform cause is possible, not established. No BIOS, WSL kernel,
  memory, CPU, or global Node configuration was changed.
- During verification PID 1017157 also crashed with the interpreter flags.
  Core `wsl-crash-1789699742-1017157-_opt_node-v24.14.0_bin_node-11.dmp`
  has PC `0x7dc41ef34399`, mapping to `Builtins_GetKeyedPropertyHandler + 89`
  (Node text `0x1b02399`). Disabling JS/regexp compilation did NOT eliminate
  the native failure. The service journal recorded exit 139 at 10:49:07,
  automatic restart at 10:49:17, and authenticated readiness at 10:49:20.
  The browser then resumed the checkpoint and received real model usage and
  streamed reasoning. This is evidence for recovery, not crash prevention.
- SQLite still held the original 203/203 extraction checkpoint. The browser's
  second restart recovery was blocked by a success latch that was never reset.

## Recovery

- Re-arm the browser's recovery guard after success and save the returned task
  identity. Keep rejection guards and the host's revision checks intact.
- Run the existing kgsrc profile with a systemd user service. Restart on failure
  after 10 seconds, at most three starts in five minutes. Do not enable login
  startup; starting DSH can resume model work.
- Use `--no-opt --no-maglev --no-sparkplug --regexp-interpret-all` only for the
  service. This is a diagnostic workaround, not a demonstrated native-crash fix.
- An initial `--jitless` experiment was rejected: incoming HTTP worked, but
  Node 24 native `fetch` failed with `WebAssembly is not defined`. The launcher
  fixture now exercises outbound streamed fetch and includes this negative case.
- The failed-transport run was cancelled during diagnosis. Before restoring that
  specific run to retryable status, the SQLite database was backed up to
  `/tmp/dsh-kgsrc-before-runtime-recovery-20260918.sqlite`. A status/timestamp CAS
  updated exactly one recovery row; canonical graph data and checkpoint contents
  were not manually changed. Normal resume then revalidated the saved checkpoint.

## Verification Boundary

Use `npm test` for repository checks and `KG_TEST_SYSTEMD=1 npm run test:dev-web`
for isolated process-death/restart-limit/intentional-stop tests. Run the latter
without concurrent systemd daemon reloads, which can reset rate-limit accounting.
The fixture never kills a real DSH process or accesses the user's graph database.
Readiness requires authenticated plugin HTTP and real model-stream activity, not
just systemd's active state or a page that renders. Short verification cannot
establish overnight stability or rule out an OS/hardware problem.

## Platform And Native Isolation (11:00-11:16 CST)

The live service was not stopped or reconfigured during this phase. Its launcher
remained PID 1022139 with `NRestarts=1`. No model calls, real graph database reads
or writes, BIOS changes, WSL restarts, or kernel changes were made by the probes.

`scripts/kg-runtime-isolation.mjs` runs bounded child processes, serially, with a
256 MiB V8 old-space ceiling and a 64 MiB integrity buffer. It checks object/JSON
round trips, strings, regex, and buffer hashes. Optional cases add only an in-memory
SQLite database, the actual require-builtin addon, or the actual flock addon using
a unique temporary file. Lock contention and reacquisition are asserted. The
second round reverses case order. Node preload flags are removed from controls;
reports include binary/script hashes, PIDs, loaded addon paths, exits and signals.
The runner rejects nonzero exits, timeouts, and missing completion markers.

Main matrix, 15 seconds per child (failures may finish earlier):

| Environment | Cases | Result |
| --- | --- | --- |
| WSL Node 24.14.0, default, five modes twice | 10 | 9 completed; pure Node SIGSEGV |
| WSL Node 24.14.0, four interpreter flags, five modes twice | 10 | All completed; NOT evidence of long-term stability |
| WSL Node 22.20.0, pure/SQLite twice | 4 | 2 SIGSEGV, 1 impossible object-allocation TypeError, 1 completed |
| Windows Node 24.14.0, script on UNC, pure/SQLite | 6 | All completed |
| Windows Node 24.14.0, script on UNC, pure repeat | 4 | 1 string-equality assertion failure, 3 completed |
| Windows Node 24.14.0, script on local C: drive, pure | 4 | 1 exit 3221225477 (0xC0000005), 3 completed |

An independent, standard-library-only Python JSON/object/regex/integrity workload
was also run with a 30-second bound. Ubuntu Python 3.10.12 PID 1044678 crashed with
SIGSEGV. Windows Python 3.12.14 completed 7,966 iterations. The Linux `timeout`
wrapper re-raised its child's SIGSEGV; its kernel-log entry is NOT an additional
independent crash.

### Preserved Failures

- Pure Node 24 PID 1043057: `wsl-crash-1789701018-1043057-_opt_node-v24.14.0_bin_node-11.dmp`.
  No third-party addon mapped; the available backtrace cannot unwind past the
  faulting anonymous code address. Do not infer a named culprit from that frame.
- Pure Node 22 PID 1043206: `wsl-crash-1789701031-1043206-_home_cwbcheng_.nvm_versions_node_v22.20.0_bin_node-11.dmp`.
  Fault site is V8 `JSDataObjectBuilder::BuildFromIterator` / `JsonParser`.
- Node 22 SQLite PID 1043260: object-literal creation threw
  `Cannot define property text, object is not extensible`, despite no freeze/seal
  operation in the standalone workload. PID 1043379 then separately SIGSEGV'd.
- Windows Node PID 43664: strict equality rejected two strings both displayed as
  `node-1064-cycle-996`. This does not establish the underlying corruption mechanism.
- Windows Node PID 14568, entirely local script and executable: native access
  violation exit `0xC0000005`. No Windows dump was captured in this phase.
- Python PID 1044678: `wsl-crash-1789701197-1044678-_usr_bin_python3.10-11.dmp`.
  PC is zero; debugger also warns about executable/core matching, so deeper symbolic
  frame attribution remains qualified.

An initial matrix additionally caught two JSON-field assertion failures and a
SQLite-mode SIGSEGV in V8 `String::WriteToFlat2` / `JsonStringifier` (PID 1033246).
Its builtin/combined cases used an invalid `instanceof Set` expectation for Node's
internal SafeSet. Those four fixture failures are excluded from component findings;
the corrected matrix checks the public `has` behavior instead. Original output was
retained rather than overwritten.

### Integrity And Platform Checks

Official release checksums and freshly extracted archives match the installed
executables. This checks installation integrity, not in-memory execution stability:

- Linux Node 24 binary SHA-256: `e237a2839d0cbdc9a9a2adda1a184afc0f5b20306ffbe923af5686550472d8a8`.
- Linux Node 22 binary SHA-256: `b1cbec894e45a5814b6ab756e1e14f8a76516273197e67e0412b57c1e10d0d9f`.
- Windows Node 24 binary SHA-256: `63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088`.
- Corrected probe SHA-256 on both platforms: `cb7a5138e6548278b72f8f4741e61ff409ab818ead8ccb6321e4684b4f9e189d`.
- `dpkg -V` reported no differences for libc6, libstdc++6, libgcc-s1,
  python3.10-minimal, and libpython3.10-minimal.
- Windows 26200.9168, WSL 2.7.10.0, kernel 6.18.33.2-microsoft-standard-WSL2;
  i9-14900HX, COLORFUL X17 Pro Max, BIOS INSYDE1.07.10TCOLO (2023-11-06),
  2 x 32 GiB RAM configured at 5200 MHz. Repository mount is ext4, not DrvFS.
- No WHEA events were returned for the preceding seven days; this does not clear
  hardware. WSL taint 512 comes from an early dxgkrnl/Xwayland WARN, not a proven
  cause of the later user-process crashes. No OOM evidence was found.

The superficially matching [WSL issue 41019](https://github.com/microsoft/WSL/issues/41019#issuecomment-4908569316)
was corrected by its author: sequential kernel comparisons were confounded by
bursty failures, and the author later attributed their desktop CPU problem to
hardware. It is NOT evidence that this machine needs a kernel downgrade, nor proof
that this mobile CPU has the same defect.

### Conclusion And Next Boundary

DSH, its two native addons, SQLite, WSL-specific execution, and Node 24-specific
behavior are not necessary for all observed failures. A shared host/platform
integrity problem is now a priority hypothesis. A common runtime/software defect
or multiple faults remains possible. These tests do NOT diagnose a particular CPU,
RAM module, firmware defect, or prove the production crash has exactly one cause.

Do not hide these failures with model retries or weaken semantic validation. Do
not treat an interpreter flag, short passing interval, or clean WHEA log as a fix.
Next disruptive work needs a maintenance window: preserve checkpoints/backups,
then use official CPU diagnostics and offline memory diagnostics before deciding
on model-specific firmware work or hardware service. No such changes were made.

Reproduce without launching DSH:

```sh
node scripts/kg-runtime-isolation.mjs --self-test
node scripts/kg-runtime-isolation.mjs --seconds 15 --rounds 2
node scripts/kg-runtime-isolation.mjs --safe-runtime --seconds 15 --rounds 2
```

Reports and the independent Python control are preserved at
`C:/Users/Dave/Documents/Codex/2026-09-08/http-127-0-0-1-3080/runtime-isolation-2026-09-18/`.
Original WSL cores remain under `C:/Users/Dave/AppData/Local/Temp/wsl-crashes/`.

### Authorized CPU Diagnostic Maintenance

The user subsequently authorized stopping DSH and installing/running Intel's
official CPU diagnostic, but not rebooting, changing BIOS, or replacing kernels.
At approximately 11:22 CST, `dsh-kgsrc-web.service` was explicitly stopped;
MainPID=0 and port 3099 no longer listened. No automatic restart was requested.

Before stopping, the full live task response including the in-memory checkpoint
for `kg-mu56vppy-1` was saved separately. Extraction was 203/203, relation discovery
was at group 27/339, with persisted search progress 48/4700. SQLite backup API
copies before and after stopping both passed quick_check and had identical SHA-256
`504382a962ae542017de5583e32be6d5c499a83e998c5e369c4570a20e7c6e14`.
The Windows backup is `runtime-isolation-2026-09-18/dsh-before-cpu-diagnostic.sqlite`
under the evidence workspace (15,712,256 bytes). The live task response and database
checkpoint are not interchangeable; both were preserved. No task cancellation or
manual database mutation was performed.

Intel IPDT 4.5 was downloaded from Intel, its published archive checksum matched,
and MSI/EXE Intel Authenticode signatures were valid. Elevated MSI installation
completed with exit 0 using `/norestart REBOOT=ReallySuppress`. A bounded CPU-only
runner was prepared using official module parameters, without burn-in or GPU load.
Its UAC launch returned "operation canceled by the user", so no diagnostic modules
ran and no CPU diagnostic result exists. Do not report a CPU pass/fail from this
installation. DSH remains intentionally stopped, and no UAC bypass was attempted.

### CPU Diagnostic Continuation Results

After the user's subsequent request to continue, normal UAC approval allowed the
CPU-only runner to execute. Its first attempt stopped after GenuineIntel succeeded
because PowerShell Start-Process returned a null exitCode for the fast process.
This was a runner defect, not a CPU failure. The first result was retained. The
runner now creates System.Diagnostics.Process directly to retain its process
handle, and writes timestamped per-run evidence directories.

The completed run lasted approximately 198 seconds, 12:18:26-12:21:44 CST.
Evidence: `runtime-isolation-2026-09-18/intel-ipdt/cpu-results-20260918-121826/`.

- GenuineIntel, BrandString, Cache, MMXSSE, IMC, PrimeNumber, FloatingPoint/AVX,
  Math/FMA3, and DGEMM AVX2 CPULoad all reported success/pass with exit 0.
- The three parallel arithmetic groups ran for 45 seconds each; DGEMM was set
  to 60 seconds. Graphics modules were excluded with documented -nographics.
- FrequencyCheck measured 2.419074 GHz but reported "No Compare Option Used"
  and exit 3. No -nc argument was supplied and Intel configuration was unchanged.
  This is measurement-only, neither a passing comparison nor a CPU fault.
- IMC allocated only 1 MiB for patterns. It did not validate the entire 64 GiB
  memory. Cache success describes size detection, not exhaustive cache stress.
- No diagnostic process crashed or timed out. No diagnostic processes remained
  after completion; no WHEA events were returned for this test window.

Thus nine groups passed and one was measurement-only, not a full default GUI-suite
pass. The run does not reproduce, explain, or invalidate the earlier independent
native crashes. It does not clear intermittent CPU/RAM/platform problems. DSH is
still intentionally inactive (MainPID=0); no reboot or BIOS/kernel changes occurred.
Offline full-memory diagnostics are a useful next boundary, but require separately
authorized reboot/maintenance. No hardware root cause or production fix is claimed.

### Recurrence After Intel Short Test: PID 1269888

The user manually started dev:web with default Node 24.14.0 flags; authenticated
readiness succeeded before another SIGSEGV (exit 139). The new 1.31 GB core at
epoch 1789719864 matches the reported PID. Port 3099 was closed at inspection and
the previously installed user service was inactive, so that foreground run was
not supervised by the service.

The fault PC 0x7ec053f15df5 is in remapped Node file-backed code. Applying its
mapping start 0x7ec053dc0000, file offset 0x154e000, and ELF LOAD delta 0x400000
gives 0x1aa3df5: Builtins_RegExpPrototypeTestFast + 1205. Matching disassembly
loads through invalid RCX=0x003d7f975800e100. This establishes the crash site,
not the original source of corruption. It is not evidence sufficient to blame
one plugin statement, SQLite, V8, or a particular hardware component.

Before recovery, another read-only SQLite backup passed quick_check; its Windows
copy hash is b2e6b5f01bdaefb7da5211df268b13962bb28b4d405518e781b048c2001b16d3.
The existing run still contains extraction 203/203. Checkpoint content hash is
unchanged from the earlier backup, so in-flight postprocessing must not be claimed
fully saved merely because the task-row updated_at advanced.

At 16:38:57 CST, the existing user service was explicitly started, restoring Node
PID 1285912 with the four diagnostic flags. Authenticated root and ontology-list
returned 200. Existing task kg-mu56vppy-1 resumed at summary aggregation with
reasoning output; no new task or manual resume request was submitted by the agent.
The existing service rate-limits starts to 3 per 300 seconds with 10-second delay;
this is not a lifetime retry cap or a root fix. Safe-runtime itself previously
crashed, so continued operation is not guaranteed. No reboot/BIOS/kernel change
was performed. Evidence is in runtime-isolation-2026-09-18/recurrence-1269888 under
the Windows task workspace. Raw monotonic dmesg was saved because dmesg -T wall
time conversion is skewed in this WSL session.
