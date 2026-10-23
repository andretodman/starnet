# Exact-file unattended routines

An operator can enroll one specialist routine to edit specific files in an already trusted
project. This is not a station-wide `cabinet:write` grant and does not authorize shell,
verification commands, connectors, delegation or other tools. Existing routines without
`fileScope` retain their existing permissions.

Use authenticated `POST /api/projects/bless` with `{"path":"/absolute/isolated-checkout"}`
first. Then authenticated `POST /api/cron` accepts:

```json
{
  "name": "Checkpoint specialist",
  "agentId": "checkpoint-worker",
  "prompt": "Implement the checkpoint source change. Read existing code first. Report actual file changes and leave runtime verification pending.",
  "schedule": "every 1h",
  "workdir": "/absolute/isolated-checkout",
  "enabledToolsets": ["cabinet"],
  "unattendedGrants": [],
  "fileScope": {
    "paths": ["Assets/Scripts/Persistence/Checkpoint.cs", "Assets/Scripts/Persistence/Checkpoint.cs.meta"]
  }
}
```

The host saves `{version:1, workdir:<canonical root>, paths:[...]}`. Existing folders must
already have explicit project trust. File names are exact, relative, bounded to 64 entries;
there are no globs or directory grants. Existing symlinks and hardlinked mutation targets
are refused. The existing project protected-file and credential floor is still enforced.

Authenticated `POST /api/cron/update` with `{"id":"...","patch":{"fileScope":{"paths":[...]}}}`
changes the enrollment; `fileScope:null` explicitly removes it. A workdir change requires
re-enrollment for the new trusted root. `script`, `noAgent`, `runsLine`, other toolsets and
unattended workbench/connector grants are incompatible with this mode. Pausing remains
possible even after trust is revoked.

Scheduled runs and Run Now use the same host-minted routine identity. Only native `fs.read`,
`fs.list`, `fs.search`, `fs.write`, `fs.append`, `fs.edit` and `fs.patch` can execute, even if
the agent otherwise has Full Access. Its desk still needs the native cabinet capability;
the scope restricts equipped tools and does not add missing equipment. Reads remain within the enrolled workdir. Every
write and every source/destination of a patch must be explicitly listed. Both ordinary
file guarding and native mutation read-back receipts remain active.

Permission is rechecked from the durable job on each tool call. Pausing/deleting the job,
revoking project trust, changing the approved instruction/scope or acquiring external
content taint prevents further effects. A model-side prompt edit revokes the enrollment
and leaves a durable revoked marker, rather than shedding the file-only restriction.
Only the operator can re-enroll it. Model-side routine creation cannot enroll files.

Scope does not flow to delegated workers, line hops or arbitrary recovered runs. A retained
routine can fire again after host restart using its same durable scope and current trust.
No job is automatically enabled, restarted or reconfigured by this feature. Use disjoint
isolated checkout paths for parallel workers, and let a separately authorized controller
validate and integrate their output. File creation is not evidence of passing runtime tests.

Regression proofs: `node test/routine-file-scope.test.js` and
`node test/routine-file-scope.e2e.test.js` (isolated host, fake provider, no paid calls).
