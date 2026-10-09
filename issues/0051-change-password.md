# 0051: Changing the password

## Context

The protect view offers "Change password" whenever the books have a
password, and says a new one "replaces the old one everywhere". It
doesn't. `LedgerSpace.setPassword` calls the SDK's `opaqueRegister`,
and the reeeductio server refuses to register a username that already
has a record at `opaque/users/{username}`: `opaque_register_init`
raises "already registered", which becomes a 409. See
[backend/space.py](https://github.com/reeeductio/reeeductio/blob/main/backend/space.py).
The server has no way to replace or remove an OPAQUE registration.

Connecting with the recovery key on a device whose books already have
a password now records that (`LedgerSpace.hasPassword`), so this
device too shows "Change password", which fails the same way.

## Acceptance criteria

- The owner can replace the password from the protect view. Afterwards
  the new password unlocks the books on any device and the old one
  does not.
- Until that works, the protect view doesn't offer a change it can't
  make: hide or reword the button, and drop the "replaces the old one
  everywhere" note.
- An e2e test against the local server covers the change.

## Notes

- Replacing needs server support: re-registration by the owner, or a
  delete followed by a new registration. Raise it upstream in
  reeeductio.
- Delete-then-register isn't atomic. If the second step fails, the
  books have no password until the owner retries, and this device's
  record says they have one. Prefer a server-side replace.
- The record lives in the data store, which has a DELETE route, but
  check what the server's OPAQUE login does with a deleted record and
  whether clients may delete it before relying on that.
