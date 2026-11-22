// Configuration comes from the process environment as it was at start-up and from nowhere else (decision untrusted-input-contained).
// `process.env.NAME` on the live object falls through to Object.prototype when NAME is not set, so anything that
// managed to add a property there could supply a setting, such as the editor command. The copy made here has no
// prototype and is frozen: a lookup finds what the user set, or nothing.

/** The own string entries of `env` on a frozen object without a prototype. Idempotent. */
export function ownEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (Object.getPrototypeOf(env) === null && Object.isFrozen(env)) return env;
  const out = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return Object.freeze(out);
}
