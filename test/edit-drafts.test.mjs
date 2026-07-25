import test from 'node:test';
import assert from 'node:assert/strict';

import { EditDrafts } from '../web/js/edit-drafts.js';

function eventSource() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

test('draft controller owns dirty state, navigation guards, and draft flushing', () => {
  const documentEvents = eventSource();
  const windowEvents = eventSource();
  const dispatched = [];
  const values = new Map();
  const textarea = {
    id: 'editor-body',
    value: 'Unsaved body',
    classList: {
      contains(name) {
        return name === 'md-easy';
      },
    },
  };
  const documentRef = {
    ...documentEvents,
    getElementById(id) {
      return id === textarea.id ? textarea : null;
    },
    querySelectorAll() {
      return [textarea];
    },
  };
  const windowRef = {
    ...windowEvents,
    dispatchEvent(event) {
      dispatched.push(event.type);
    },
  };
  const storage = {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  globalThis.CustomEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  const drafts = EditDrafts.create({
    documentRef,
    windowRef,
    storage,
    confirmLeave: () => false,
    now: () => 1234,
  });

  documentRef.emit('input', {
    target: { closest: selector => selector === '.edit-form' },
  });
  assert.equal(drafts.isDirty(), true);
  assert.deepEqual(dispatched, ['editmode:dirty']);

  let unloadPrevented = false;
  const unload = {
    preventDefault() {
      unloadPrevented = true;
    },
    returnValue: null,
  };
  windowRef.emit('beforeunload', unload);
  assert.equal(unloadPrevented, true);
  assert.equal(unload.returnValue, '');

  let change;
  drafts.wireEasyMDE({
    codemirror: {
      on(type, listener) {
        if (type === 'change') change = listener;
      },
    },
  }, textarea);
  change();
  windowRef.emit('pagehide');
  assert.deepEqual(JSON.parse(values.get('md_draft:editor-body')), {
    content: 'Unsaved body',
    savedAt: 1234,
  });

  let clickPrevented = false;
  let propagationStopped = false;
  documentRef.emit('click', {
    target: { closest: selector => selector === 'a[href^="#/"]' ? {} : null },
    preventDefault() {
      clickPrevented = true;
    },
    stopPropagation() {
      propagationStopped = true;
    },
  });
  assert.equal(clickPrevented, true);
  assert.equal(propagationStopped, true);
  assert.equal(drafts.isDirty(), true);

  drafts.markClean();
  assert.equal(drafts.isDirty(), false);
  assert.equal(values.has('md_draft:editor-body'), false);
  assert.deepEqual(dispatched, ['editmode:dirty', 'editmode:clean']);
});
