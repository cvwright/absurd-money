/**
 * A keydown listener for sign-in fields: Enter submits the field's form even when a
 * password manager's extension keeps the browser from doing it (Apple Passwords in Brave
 * does). Taking the default away avoids a second submit. Like the browser, it does nothing
 * while the submit button is disabled, which `requestSubmit` alone would not check.
 */
export function enterSubmits(e: KeyboardEvent): void {
  const form = (e.target as HTMLInputElement).form;
  if (e.key !== 'Enter' || e.isComposing || !form) return;
  e.preventDefault();
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit?.disabled) form.requestSubmit(submit);
}
