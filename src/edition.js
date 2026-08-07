// What this install IS.
//
// Nothing here is entered, verified, or checked against a server. There is no
// licence, no key, no phone-home, and no "am I allowed?" question anywhere in
// the app — because the answer is already sitting on disk. An install can only
// report what it is; it can never be wrong about it, and there is nothing for a
// user to get right or get wrong.
//
// This repository is the FREE edition: the premium features are not gated here,
// they are simply not present (see src/upgrade.js). So the only thing left to
// observe is WHO RUNS THE SERVER:
//
//   managed  Set by INV_HOSTED in the service environment — the platform sets
//            it, not the shop owner, because on a hosted box the shop owner has
//            no shell to set it from.
//
//   free     self-hosted: somebody at the keyboard has a keyboard on the box.
//   hosted   we run it.
//
// ---------------------------------------------------------------------------
// Why INV_HOSTED is not a bypass
// ---------------------------------------------------------------------------
// Setting it grants NOTHING. It cannot unlock a feature, because no feature in
// this build is locked — the code for it isn't here. All it does is REMOVE
// self-service controls and swap "run this command" for "contact support".
// Someone who sets it on their own machine gets a worse experience and no extra
// features, so there is nothing to defend against — which is exactly the
// property that lets the whole thing stay this simple.
import { upgradeUrl } from './upgrade.js';

const truthy = (v) => v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

/** True when this process is running on infrastructure we operate. */
export const isManaged = () => truthy(process.env.INV_HOSTED);

/**
 * Where to send someone who needs something they cannot do themselves.
 *
 * A managed customer has no shell, so "run sudo update.sh" is not advice, it is
 * a dead end. Configurable so a reseller running their own hosted fleet points
 * at their own desk rather than ours.
 */
export const supportUrl = () => process.env.INV_SUPPORT_URL || '';

const LABELS = { free: 'Free', hosted: 'Hosted' };

/**
 * The full picture, derived fresh each call so a restart with a different
 * environment is immediately correct (and so tests can flip it).
 */
export function current() {
  const managed = isManaged();
  const key = managed ? 'hosted' : 'free';
  return {
    key,
    managed,
    label: LABELS[key],
    // Can this install change itself by running a command? Only if somebody at
    // the keyboard actually has a keyboard on the box.
    selfServiceable: !managed,
    supportUrl: managed ? supportUrl() : '',
    // Where to ask about Pro. Same answer either way today, because upgrading
    // is a conversation rather than a command — see src/upgrade.js.
    upgradeUrl: upgradeUrl(),
  };
}

/** One line for the boot banner and the fleet log. */
export function describe() {
  const e = current();
  return e.managed ? `${e.label} (managed)` : `${e.label} (self-hosted)`;
}
