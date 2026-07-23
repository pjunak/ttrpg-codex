const moduleRevision = new URL(import.meta.url).searchParams.get('codex-revision') || '';

export default function register(host) {
  const state = globalThis.__addonLifecycleState;
  const config = state.config[host.id] || {};
  const instance = {
    id: host.id,
    revision: host.contentRevision,
    moduleRevision,
    active: true,
    lookup: () => instance.active ? instance.revision : null,
  };
  state.instances[host.id] = instance;
  state.events.push(`register:${host.id}:${host.contentRevision}:${moduleRevision}`);

  if (config.consume) {
    try {
      const provider = host.use(config.consume);
      state.consumerApis[host.id] = provider;
    } catch (error) {
      if (!config.allowMissing) throw error;
      state.events.push(`consumer-missing:${host.id}`);
    }
  }
  if (config.provide) host.provide(instance);
  host.registerRoute(host.id, () => host.contentRevision);
  host.onDispose(() => {
    const provider = state.consumerApis[host.id];
    if (provider) state.events.push(`consumer-sees:${host.id}:${provider.lookup()}`);
    instance.active = false;
    state.events.push(`onDispose:${host.id}:${host.contentRevision}`);
  });

  if (config.failAfterRegister) throw new Error(`register failure: ${host.id}`);

  return async () => {
    state.events.push(`returnedDispose:${host.id}:${host.contentRevision}`);
    if (config.rejectDispose) throw new Error(`dispose failure: ${host.id}`);
    if (config.hangDispose) await new Promise(() => {});
  };
}
