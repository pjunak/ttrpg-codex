const BUILTIN_SECTIONS = new Set([
  '', 'dashboard', 'parta', 'postavy', 'postava', 'mista', 'misto',
  'udalosti', 'udalost', 'zahady', 'zahada', 'frakce', 'mazlicci',
  'panteon', 'buh', 'artefakty', 'artefakt',
  'historie', 'historicka-udalost', 'nastaveni', 'dm', 'mapa', 'casova-osa',
]);

function orderOf(options) {
  return Number.isFinite(options?.order) ? options.order : 0;
}

export const AddonRegistrationContract = Object.freeze({
  route(segment, render) {
    if (typeof segment !== 'string' || !segment) {
      throw new Error('registerRoute: segment must be a non-empty string');
    }
    if (typeof render !== 'function') {
      throw new Error('registerRoute: render must be a function');
    }
    if (BUILTIN_SECTIONS.has(segment)) {
      throw new Error(`registerRoute: "${segment}" collides with a built-in route`);
    }
    return { segment, render };
  },

  sidebarPage(spec) {
    if (!spec || typeof spec.route !== 'string' || !spec.route) {
      throw new Error('registerSidebarPage: spec.route required');
    }
    return spec;
  },

  pageRenderer(kind, render) {
    if (typeof kind !== 'string' || !kind) {
      throw new Error('registerPageRenderer: kind required');
    }
    if (typeof render !== 'function') {
      throw new Error('registerPageRenderer: render must be a function');
    }
    return { kind, render };
  },

  articleSection(kind, fn, options) {
    if (typeof kind !== 'string' || !kind) {
      throw new Error('registerArticleSection: kind required');
    }
    if (typeof fn !== 'function') {
      throw new Error('registerArticleSection: fn must be a function');
    }
    return { kind, fn, order: orderOf(options) };
  },

  settingsTab(spec) {
    if (!spec || typeof spec.render !== 'function') {
      throw new Error('registerSettingsTab: spec.render required');
    }
    return spec;
  },

  action(name, fn) {
    if (typeof name !== 'string' || !name) {
      throw new Error('registerAction: name required');
    }
    if (typeof fn !== 'function') {
      throw new Error('registerAction: fn must be a function');
    }
    return { name, fn };
  },

  editorFields(kind, spec) {
    if (typeof kind !== 'string' || !kind) {
      throw new Error('registerEditorFields: kind required');
    }
    if (!spec || typeof spec.fields !== 'function') {
      throw new Error('registerEditorFields: spec.fields required');
    }
    return { kind, spec };
  },

  fragmentOp(target, spec) {
    if (typeof target !== 'string' || !target) {
      throw new Error('registerFragmentOp: target required');
    }
    const value = spec || {};
    const op = value.op;
    if (!['replace', 'hide', 'wrap', 'insert'].includes(op)) {
      throw new Error('registerFragmentOp: op must be replace|hide|wrap|insert');
    }
    if (op !== 'hide' && typeof value.render !== 'function') {
      throw new Error(`registerFragmentOp: op "${op}" needs a render(html, ctx) function`);
    }
    return {
      target,
      op,
      render: typeof value.render === 'function' ? value.render : null,
      order: orderOf(value),
      position: op === 'insert' && value.position === 'before' ? 'before' : 'after',
    };
  },

  slot(slotId, render, options) {
    if (typeof slotId !== 'string' || !slotId) {
      throw new Error('registerSlot: slotId required');
    }
    if (typeof render !== 'function') {
      throw new Error('registerSlot: render must be a function');
    }
    return {
      slotId,
      render,
      order: orderOf(options),
      permission: `ui:slot:${slotId.split(':')[0]}`,
    };
  },

  kind(domain, def) {
    if (typeof domain !== 'string' || !domain) {
      throw new Error('registerKind: domain required');
    }
    if (!def || typeof def.id !== 'string' || !def.id) {
      throw new Error('registerKind: def.id required');
    }
    return { domain, def, permission: `kinds:${domain}` };
  },

  nodeKind(def) {
    if (!def || typeof def.id !== 'string' || !def.id) {
      throw new Error('registerNodeKind: def.id required');
    }
    return def;
  },

  graphView(def) {
    if (!def || typeof def.id !== 'string' || !def.id) {
      throw new Error('registerGraphView: def.id required');
    }
    return def;
  },

  graphContributor(viewId, fn) {
    if (typeof viewId !== 'string' || !viewId) {
      throw new Error('registerGraphContributor: viewId required');
    }
    if (typeof fn !== 'function') {
      throw new Error('registerGraphContributor: fn must be a function');
    }
    return { viewId, fn };
  },

  wikiKind(scope, resolve) {
    if (typeof scope !== 'string' || !scope) {
      throw new Error('registerWikiKind: scope required');
    }
    if (typeof resolve !== 'function') {
      throw new Error('registerWikiKind: resolve must be a function');
    }
    if (BUILTIN_SECTIONS.has(scope)) {
      throw new Error(`registerWikiKind: "${scope}" collides with a built-in scope`);
    }
    return { scope, resolve };
  },
});
