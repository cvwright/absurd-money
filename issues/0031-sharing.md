# 0031: Sharing with a second family member

## Context

Step 7 of the design's build order, and the reason the books are signed
and chained at all: see "Shared books" in
[design/ACCOUNTING.md](../design/ACCOUNTING.md). This issue is the first
milestone, the **spouse or full partner**: a second person with their
own identity, their own devices, and the same access as the owner. The
accountant's read-only hand-off is a later issue (0055), since it needs
the SDK to work from topic keys (0032).

Today the books have exactly one identity. The space ID is the owner's
public key, and the code leans on that:

- Every unlock path checks that the private key signs for the space ID
  (`withSecrets` in `src/services/credentials.ts`). A member's key
  never will.
- `credentialsFromRecoveryKey` takes the public key from the space ID.
- The OPAQUE username is the literal `owner` (`OWNER_USERNAME`), and
  `hasPassword` probes `opaque/users/owner`.
- The space creator has "god mode" on the server
  ([authorization.py](https://github.com/reeeductio/reeeductio/blob/main/backend/authorization.py)),
  so nothing has ever needed a capability.

A full partner holds the symmetric root, as the design says. For them,
capabilities limit what they can write and what the server will serve.
They do not hide anything, since the root derives every key. That is
the right model for a household, and it means this milestone needs no
SDK change.

## Acceptance criteria

- **Invite.** The owner creates an invitation from the app. It is a
  single link or QR code carrying the space ID, a one-time invitation
  key, and the symmetric root, with the secrets in the URL fragment so
  they never reach a server log. The app says plainly that the
  invitation opens the books and should be handed over in person or
  over a channel the owner trusts.
- **Accept.** The invitee opens the link on their own device. The app
  generates their own Ed25519 key pair, uses the invitation key to
  create their user entry and assign the partner role, and then runs
  the usual protect flow: a passkey, a password, or both, and a
  recovery key shown once. The invitation can't be used a second time.
- **Partner role.** A role (`partner`) with write on every journal
  segment, `budget`, `recon`, `checkpoints`, `state/ledger/{...}`, and
  blobs, and read on everything the app reads. It has nothing under
  `auth/`, so a partner can't invite, remove, or re-role anyone. The
  role and its capabilities are created once, by the owner, the first
  time they invite someone.
- **Unlock as a member.** Recovery key, passkey, and password all work
  for a member. The key check derives the public key from the private
  key and accepts it if it is the space's key or a user with a role in
  the space. Each member's OPAQUE username is their user ID, which is
  not user-derived and is safe in a path.
- **Names.** Each person has a display name, kept in one State
  document (`ledger/members`, user ID to name, encrypted like the other
  `ledger/` documents). A member sets their own name on joining. This
  is one write per person, not per transaction.
- **Attribution.** The register and the entry detail show who posted
  each entry and each edit, from the message's `sender`. Unknown
  senders show their user ID, never nothing.
- **Members list.** A settings view lists the owner and members with
  their names. The owner can remove a member, which deletes their role
  grant. The view says what removal does and doesn't do: it stops new
  reads and writes, but the member keeps everything they already
  synced and still holds the root.
- **Concurrency.** Two people posting at once is the normal case now.
  An e2e test runs two clients as two users against the local server,
  posting to the same segment and editing the same State document, and
  checks that both writes land after CAS retries and that both
  projections agree.
- **Schemas.** `ledger/members` gets a schema in
  [design/SCHEMAS.md](../design/SCHEMAS.md), with a `v` field.

## Notes

- **Capability paths for segments.** The design writes
  `topics/journal`, but the topics are `journal-YYYY`. Check whether a
  path segment can be a partial wildcard (`journal-{any}`). If it
  can't, the role grants `topics/{any}`, which also covers `budget`,
  `recon`, and the rest. Granting each year separately would mean a
  role write every January and a failed post until it happens.
- **The SDK's `createInvitation`** grants a role named `user` and
  nothing else, and never sets a `use_limit`. reeeductio TODO item 25
  asks for invitations with any roles, a default single use, and an
  accept helper. Until then, build the invitation from `createTool` and
  `grantCapabilityToTool` with our own role and a `use_limit` of 2
  (create the user, assign the role); the server enforces it. The
  owner's members view should still list unused invitations and revoke
  them.
- **A partner's password.** `opaqueRegister` registers the caller's
  own key pair, but registering needs the `opaque-user` role, which
  `enableOpaque` set up for the owner. The partner role needs that
  capability too. Changing a password still fails (0051) for everyone.
- **Password managers.** The owner's password manager sees the space
  ID as the username. A member's login needs both the space ID and
  their user ID. Decide how the unlock form gets both without asking
  the user to type a user ID (0054 is related).
- **Owner-only actions** stay owner-only by not granting them: invite,
  remove, set up OPAQUE. Whether a partner may restructure the chart
  is a choice. The design's "full partner" can, and that is the
  default here.
- **Removing someone is not re-keying.** The design's caveat applies in
  full. A real separation (a divorce, say) needs new books or a re-key,
  which is out of scope. Say so in the UI, not just here.
- **Checkpoints.** Once two people can post, "who may sign a
  checkpoint" (0028 and the design's open question) gets a real answer
  to give. Not needed for this issue, since checkpoints aren't written
  yet.
- **Not here:** the bookkeeper role (write the journal, read the
  chart), the accountant (0055), and a kid's allowance ledger, which
  the design says is its own space.
