# 0054: Enter doesn't submit sign-in forms with Apple Passwords

## Context

Pressing Enter in the lock screen's password field did nothing in
Brave 1.96.61, though clicking "Unlock with password" worked. The form
is an ordinary `<form>` with a submit button, and Enter submitted it in
headless Chrome and Brave, both for the view alone and for the full
app. It worked in a private window too. The cause was the Apple
Passwords extension, which decorates sign-in fields and keeps the
browser from doing the form's own Enter handling (implicit submission)
in them.

## Acceptance criteria

- Enter submits every sign-in form with the extension installed: the
  lock screen (password, recovery key), setup (space ID, password,
  recovery key), and setting a password.
- Enter never submits twice, or while the form's submit button is
  disabled.

## Resolution

2026-10-08. `enterSubmits` (`src/components/enter-submits.ts`) is a
keydown listener on those fields. On Enter it takes the default away
and calls `requestSubmit` on the field's form, unless the submit
button is disabled, which `requestSubmit` alone wouldn't check.
Confirmed on the lock screen with the extension in Brave; the other
forms were checked only without it. If an extension ever stops the
key before it reaches the field, nothing in the page can catch it.
