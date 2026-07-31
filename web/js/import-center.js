import { createAddonImportClient } from './addon-imports.js';
import { I18n } from './i18n.js';
import {
  applyLocationAdjustments,
  buildStoryReview,
  locateChangeSource,
  setValueAtPath,
  valueAtPath,
} from './import-review.js';
import { PinTypes } from './pin-types.js';
import { Role } from './role.js';
import { Store } from './store.js';
import { announce, dataAction, dataOn, esc, safeColor } from './utils.js';

const PROVIDER_ID = 'campaign-bundle';
const WORLD_MAP_IMAGE = '/maps/swordcoast/sword_coast.jpg';

export const ImportCenter = (() => {
  let _file = null;
  let _preview = null;
  let _result = null;
  let _error = null;
  let _busy = '';
  let _confirmed = false;
  let _jobId = '';
  let _generation = 0;
  let _storyGraph = null;
  let _storyReview = null;
  let _dragCleanup = null;
  let _sourceOriginal = null;
  let _sourceDraft = null;
  const _sourceLocations = new Map();
  const _editedSourcePaths = new Set();
  const _mapAdjustments = new Map();

  const _client = createAddonImportClient({
    addonId: 'core',
    enabled: true,
    isDM: () => Role.isDM(),
  });

  function _main() {
    return document.getElementById('main-content');
  }

  function _button(label, action, className = 'inline-create-btn', disabled = false, id = '') {
    return `<button type="button" class="${className}"${id ? ` id="${id}"` : ''}${dataAction(action)}${disabled ? ' disabled' : ''}>${label}</button>`;
  }

  function _severityLabel(severity) {
    if (severity === 'error') return I18n.t('import.severity.error');
    if (severity === 'warning') return I18n.t('import.severity.warning');
    return I18n.t('import.severity.info');
  }

  function _diagnosticsHtml(diagnostics = []) {
    if (!diagnostics.length) {
      return `<p class="import-empty">${esc(I18n.t('import.noDiagnostics'))}</p>`;
    }
    return `<ul class="import-diagnostics">${diagnostics.map(item => `
      <li class="is-${['error', 'warning', 'info'].includes(item.severity) ? item.severity : 'info'}">
        <div class="import-diagnostic-head">
          <span aria-hidden="true">${item.severity === 'error' ? '×' : item.severity === 'warning' ? '!' : 'i'}</span>
          <strong>${esc(_severityLabel(item.severity))}</strong>
          ${item.code ? `<code>${esc(item.code)}</code>` : ''}
        </div>
        <p>${esc(item.message || '')}</p>
        ${Array.isArray(item.path) && item.path.length
          ? `<code class="import-diagnostic-path">${esc(item.path.join('.'))}</code>`
          : ''}
      </li>`).join('')}</ul>`;
  }

  function _referencesHtml(references = []) {
    if (!references.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `
      <div class="import-table-wrap">
        <table class="import-table">
          <thead><tr>
            <th>${esc(I18n.t('import.localRef'))}</th>
            <th>${esc(I18n.t('import.collection'))}</th>
            <th>${esc(I18n.t('import.reservedId'))}</th>
          </tr></thead>
          <tbody>${references.map(item => `
            <tr>
              <td><code>${esc(item.ref)}</code></td>
              <td>${esc(item.collection)}</td>
              <td><code>${esc(item.id)}</code></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function _fieldLabel(field) {
    const key = `import.field.${field}`;
    const translated = I18n.t(key);
    if (translated !== key) return translated;
    return String(field)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/^./, value => value.toUpperCase());
  }

  function _fieldOptions(field, path, currentValue) {
    let values = null;
    if (field === 'operation') values = ['create', 'update'];
    if (field === 'kind') values = ['thread', 'quest', 'scenario', 'encounter', 'note'];
    if (field === 'state') values = ['idea', 'ready', 'active', 'resolved', 'archived'];
    if (field === 'visibility') values = ['public', 'dm'];
    if (field === 'scope') values = ['planning', 'core', 'external'];
    if (field === 'type' && path.includes('addonImports') && path.includes('links')) {
      values = [
        'related',
        'involves',
        'supports',
        'opposes',
        'reveals',
        'requires',
        'precedes',
        'branches',
      ];
    }
    if (!values) return null;
    if (typeof currentValue === 'string' && currentValue && !values.includes(currentValue)) {
      values.unshift(currentValue);
    }
    return values;
  }

  function _sourceControl(value, path, field, editable) {
    const label = esc(_fieldLabel(field));
    const pathAttribute = editable
      ? ` data-import-source-path="${esc(JSON.stringify(path))}"`
      : '';
    if (typeof value === 'boolean') {
      return `<label class="import-form-field is-boolean">
        <input type="checkbox"${value ? ' checked' : ''}${editable ? pathAttribute : ' disabled'}>
        <span>${label}</span>
      </label>`;
    }
    const options = _fieldOptions(field, path, value);
    if (options) {
      return `<label class="import-form-field">
        <span>${label}</span>
        <select class="edit-input"${editable ? pathAttribute : ' disabled'}>
          ${options.map(option => `<option value="${esc(option)}"${option === value ? ' selected' : ''}>${esc(_fieldLabel(option))}</option>`).join('')}
        </select>
      </label>`;
    }
    const type = typeof value;
    const serialized = value === null ? '' : String(value ?? '');
    const valueType = value === null ? 'null' : type;
    const isLong = type === 'string'
      && (serialized.length > 120 || ['body', 'description', 'summary', 'notes', 'backstory']
        .includes(field));
    if (isLong) {
      return `<label class="import-form-field is-wide">
        <span>${label}</span>
        <textarea class="edit-input" rows="${Math.min(12, Math.max(3, serialized.split('\n').length + 1))}"
          data-import-value-type="${valueType}"${editable ? pathAttribute : ' readonly'}>${esc(serialized)}</textarea>
      </label>`;
    }
    return `<label class="import-form-field">
      <span>${label}</span>
      <input class="edit-input" type="${type === 'number' ? 'number' : 'text'}"
        ${type === 'number' ? 'step="any"' : ''} value="${esc(serialized)}"
        data-import-value-type="${valueType}"${editable ? pathAttribute : ' readonly'}>
    </label>`;
  }

  function _sourceFields(value, path = [], editable = false, field = '') {
    if (Array.isArray(value)) {
      const pathJson = esc(JSON.stringify(path));
      const addButton = editable
        ? `<button type="button" class="inline-create-btn import-array-add"
            data-import-array-action="add" data-import-array-path="${pathJson}">
            ${esc(I18n.t('import.addListItem'))}
          </button>`
        : '';
      if (!value.length) {
        return `<div class="import-form-array">
          <div class="import-form-empty">${esc(I18n.t('import.emptyList'))}</div>
          ${addButton}
        </div>`;
      }
      return `<div class="import-form-array">${value.map((entry, index) => {
        const entryPath = [...path, index];
        if (entry && typeof entry === 'object') {
          return `<fieldset class="import-form-group">
            <legend>
              <span>${esc(I18n.t('import.listItem', { count: index + 1 }))}</span>
              ${editable ? `<button type="button" class="import-array-remove"
                data-import-array-action="remove" data-import-array-path="${pathJson}"
                data-import-array-index="${index}">${esc(I18n.t('import.removeListItem'))}</button>` : ''}
            </legend>
            ${_sourceFields(entry, entryPath, editable)}
          </fieldset>`;
        }
        return `<div class="import-array-scalar">
          ${_sourceControl(entry, entryPath, `${field || 'item'} ${index + 1}`, editable)}
          ${editable ? `<button type="button" class="import-array-remove"
            data-import-array-action="remove" data-import-array-path="${pathJson}"
            data-import-array-index="${index}">${esc(I18n.t('import.removeListItem'))}</button>` : ''}
        </div>`;
      }).join('')}${addButton}</div>`;
    }
    if (value && typeof value === 'object') {
      return `<div class="import-form-grid">${Object.entries(value).map(([key, entry]) => {
        const entryPath = [...path, key];
        if (entry && typeof entry === 'object') {
          return `<fieldset class="import-form-group is-wide">
            <legend>${esc(_fieldLabel(key))}</legend>
            ${_sourceFields(entry, entryPath, editable, key)}
          </fieldset>`;
        }
        return _sourceControl(entry, entryPath, key, editable);
      }).join('')}</div>`;
    }
    return _sourceControl(value, path, field || 'value', editable);
  }

  function _recordForm(value, path = [], editable = false) {
    if (value === null || value === undefined) {
      return `<p class="import-empty">${esc(I18n.t('import.noExistingValue'))}</p>`;
    }
    return `<div class="import-record-form${editable ? ' is-editable' : ' is-readonly'}">
      ${_sourceFields(value, path, editable)}
    </div>`;
  }

  function _changeHtml(change, className = '') {
    const label = change.after?.title || change.after?.name || change.after?.label
      || change.sourceRef || change.id;
    const statusKey = change.status === 'update' ? 'import.update' : 'import.create';
    const sourceKey = `${change.collection}:${change.id}`;
    let source = _sourceDraft ? locateChangeSource(_sourceDraft, change) : null;
    if (source) {
      _sourceLocations.set(sourceKey, source.path);
    } else if (_sourceDraft && _sourceLocations.has(sourceKey)) {
      const path = _sourceLocations.get(sourceKey);
      const value = valueAtPath(_sourceDraft, path);
      if (value !== undefined) source = { path, value };
    }
    const after = source?.value ?? change.after;
    return `
      <details class="import-change${className ? ` ${className}` : ''}"
        data-change-id="${esc(`${change.collection}:${change.id}`)}">
        <summary>
          <span class="import-change-kind">${esc(change.collection)}</span>
          <strong>${esc(label)}</strong>
          <span class="codex-badge">${esc(I18n.t(statusKey))}</span>
          ${change.derived ? `<span class="codex-badge is-warning">${esc(I18n.t('import.derived'))}</span>` : ''}
        </summary>
        <div class="import-change-body">
          ${change.sourceRef ? `<p><span>${esc(I18n.t('import.localRef'))}</span> <code>${esc(change.sourceRef)}</code></p>` : ''}
          <div class="import-diff">
            <section>
              <h4>${esc(I18n.t('import.before'))}</h4>
              ${_recordForm(change.before)}
            </section>
            <section>
              <h4>${esc(I18n.t(source ? 'import.afterEditable' : 'import.after'))}</h4>
              ${source
                ? `<p class="import-form-hint">${esc(I18n.t('import.editHint'))}</p>`
                : `<p class="import-form-hint">${esc(I18n.t('import.derivedReadOnly'))}</p>`}
              ${_recordForm(after, source?.path || [], !!source)}
            </section>
          </div>
        </div>
      </details>`;
  }

  function _changesHtml(changes = []) {
    if (!changes.length) return `<p class="import-empty">${esc(I18n.t('import.none'))}</p>`;
    return `<div class="import-change-list">${changes.map(_changeHtml).join('')}</div>`;
  }

  function _mapGroups(changes = []) {
    const changedLocations = new Map(
      changes
        .filter(change => change.collection === 'locations' && change.after)
        .map(change => [change.id, {
          ...change.after,
          sourceRef: change.sourceRef || '',
        }]),
    );
    const groups = new Map();
    for (const [id, location] of changedLocations) {
      if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) continue;
      const parentId = typeof location.parentId === 'string' ? location.parentId : '';
      if (!groups.has(parentId)) groups.set(parentId, []);
      groups.get(parentId).push({ id, ...location });
    }
    return [...groups].map(([parentId, changedPins]) => {
      const parent = parentId
        ? (changedLocations.get(parentId) || Store.getLocation(parentId))
        : null;
      const pins = new Map(
        (Store.getLocationsOnMap(parentId || null) || [])
          .filter(location => Number.isFinite(location.x) && Number.isFinite(location.y))
          .map(location => [location.id, { ...location, changed: false }]),
      );
      for (const pin of changedPins) pins.set(pin.id, { ...pin, changed: true });
      return {
        parentId,
        label: parent?.name || I18n.t('import.worldMap'),
        image: parentId ? parent?.localMap : WORLD_MAP_IMAGE,
        changedCount: changedPins.length,
        pins: [...pins.values()],
      };
    });
  }

  function _mapPreviewHtml(changes = []) {
    const pinTypes = Store.getEnum('pinTypes') || [];
    const groups = _mapGroups(changes);
    if (!groups.length) return `<p class="import-empty">${esc(I18n.t('import.noMapChanges'))}</p>`;
    return `<div class="import-map-list">${groups.map(group => `
      <figure class="import-map-card">
        <figcaption>
          <strong>${esc(group.label)}</strong>
          <span>${esc(I18n.t('import.changedPins', { count: group.changedCount }))}</span>
        </figcaption>
        <div class="import-map-stage${group.image ? '' : ' has-no-image'}">
          ${group.image
            ? `<img src="${esc(group.image)}" alt="" loading="lazy">`
            : `<p>${esc(I18n.t('import.mapUnavailable'))}</p>`}
          ${group.pins.map(pin => {
            const definition = PinTypes.resolve(pinTypes, pin.pinType);
            const size = Math.max(
              PinTypes.sizeMin,
              Math.min(PinTypes.sizeMax, Number(pin.size) || Number(definition.size) || PinTypes.sizeDefault),
            );
            const adjustment = pin.sourceRef ? _mapAdjustments.get(pin.sourceRef) : null;
            const x = Math.max(0, Math.min(1, adjustment?.x ?? pin.x));
            const y = Math.max(0, Math.min(1, adjustment?.y ?? pin.y));
            const adjustable = !!(pin.changed && pin.sourceRef && group.image);
            const tag = adjustable ? 'button' : 'span';
            const attributes = adjustable
              ? ` type="button" data-source-ref="${esc(pin.sourceRef)}" data-map-x="${x}" data-map-y="${y}" aria-label="${esc(I18n.t('import.movePin', { name: pin.name || pin.id }))}"`
              : '';
            return `<${tag} class="import-map-pin${pin.changed ? ' is-changed' : ' is-existing'}${adjustable ? ' is-adjustable' : ''}"
              ${attributes}
              style="--import-pin-x:${(x * 100).toFixed(4)}%;--import-pin-y:${(y * 100).toFixed(4)}%;--import-pin-size:${size}px;--import-pin-color:${safeColor(definition.color)}"
              title="${esc(pin.name || pin.id)}">
                <span aria-hidden="true">${esc(definition.icon || '📌')}</span>
                <b>${esc(pin.name || pin.id)}</b>
              </${tag}>`;
          }).join('')}
        </div>
      </figure>`).join('')}</div>`;
  }

  function _coreRecord(collection, id) {
    if (collection === 'characters') return Store.getCharacter(id);
    if (collection === 'locations') return Store.getLocation(id);
    if (collection === 'factions') return Store.getFaction(id);
    if (collection === 'mysteries') return Store.getMystery(id);
    if (collection === 'artifacts') return Store.getArtifact(id);
    if (collection === 'events') return Store.getEvent(id);
    return null;
  }

  function _storyModel(changes = []) {
    const changedCore = new Map(changes
      .filter(change => ['characters', 'locations', 'factions', 'mysteries', 'artifacts', 'events']
        .includes(change.collection) && change.after)
      .map(change => [`${change.collection}:${change.id}`, change.after]));
    const relationshipTypes = new Map((Store.getEnum('relationshipTypes') || [])
      .map(type => [type.id, type.target === 'location' ? 'locations' : 'characters']));
    return buildStoryReview(changes, {
      coreLabel: (collection, id) => {
        const record = changedCore.get(`${collection}:${id}`) || _coreRecord(collection, id);
        return record?.name || record?.title || record?.label || id;
      },
      relationshipTarget: type => relationshipTypes.get(type) || 'characters',
    });
  }

  function _storyOutlineHtml(story, changes) {
    if (!story.items.length) return '';
    const byId = new Map(changes
      .filter(change => change.collection.endsWith(':planning_items'))
      .map(change => [change.id, change]));
    return `<div class="import-story-cards">${story.items.map(item => {
      const change = byId.get(item.id);
      if (!change) return '';
      return _changeHtml(
        change,
        `import-story-change is-${item.kind || 'note'}`,
      );
    }).join('')}</div>`;
  }

  function _storyConnectionsHtml(story) {
    const edges = story.edges.filter(edge => edge.type !== 'precedes' && edge.type !== 'branches');
    if (!edges.length) return '';
    const nodes = new Map(story.nodes.map(node => [node.id, node]));
    const items = new Map(story.items.map(item => [item.id, item]));
    const sectionLabel = (node, sectionId) => {
      if (!sectionId || node?.scope !== 'planning') return '';
      const section = (items.get(node.recordId)?.sections || [])
        .find(value => value.id === sectionId);
      return section?.title || sectionId;
    };
    return `
      <details class="import-story-connections">
        <summary>${esc(I18n.t('import.storyConnections', { count: edges.length }))}</summary>
        <ul>${edges.map(edge => {
          const source = nodes.get(edge.source);
          const target = nodes.get(edge.target);
          const sourceSection = sectionLabel(source, edge.sourceSectionId);
          const targetSection = sectionLabel(target, edge.targetSectionId);
          return `<li>
            <span>${esc(source?.label || edge.source)}${sourceSection ? ` · ${esc(sourceSection)}` : ''}</span>
            <strong>${esc(edge.label || edge.type)}</strong>
            <span>${esc(target?.label || edge.target)}${targetSection ? ` · ${esc(targetSection)}` : ''}</span>
            ${edge.notes ? `<p>${esc(edge.notes)}</p>` : ''}
          </li>`;
        }).join('')}</ul>
      </details>`;
  }

  function _flowConnectionsHtml(story) {
    if (!story.flowEdges.length) return '';
    const nodes = new Map(story.flowNodes.map(node => [node.id, node]));
    return `<ol class="import-flow-list">${story.flowEdges.map(edge => {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      return `<li class="is-${edge.type}">
        <span class="import-flow-source">
          ${source?.parentLabel ? `<small>${esc(source.parentLabel)}</small>` : ''}
          <strong>${esc(source?.label || edge.source)}</strong>
        </span>
        <span class="import-flow-transition">
          <b>${esc(edge.label)}</b>
          <small>${esc(I18n.t(edge.type === 'branches'
            ? 'import.flowBranch'
            : 'import.flowNext'))}</small>
        </span>
        <span class="import-flow-target">
          ${target?.parentLabel ? `<small>${esc(target.parentLabel)}</small>` : ''}
          <strong>${esc(target?.label || edge.target)}</strong>
        </span>
      </li>`;
    }).join('')}</ol>`;
  }

  function _storyPreviewHtml(changes = []) {
    _storyReview = _storyModel(changes);
    if (!_storyReview.nodes.length && !_storyReview.items.length) {
      return `<p class="import-empty">${esc(I18n.t('import.noStoryChanges'))}</p>`;
    }
    return `
      <div class="import-story-evidence">
        ${_storyReview.flowNodes.length ? `
          <div class="import-story-graph-shell">
            <div id="import-story-graph" class="import-story-graph"
              role="img" aria-label="${esc(I18n.t('import.flowGraphLabel'))}"></div>
            <p class="import-story-graph-fallback" hidden>${esc(I18n.t('import.graphUnavailable'))}</p>
          </div>
          ${_flowConnectionsHtml(_storyReview)}
        ` : `
          <div class="import-flow-empty">
            <strong>${esc(I18n.t('import.noFlowTitle'))}</strong>
            <p>${esc(I18n.t('import.noFlowHint'))}</p>
          </div>
        `}
        ${_storyConnectionsHtml(_storyReview)}
        ${_storyOutlineHtml(_storyReview, changes)}
      </div>`;
  }

  function _destroyStoryGraph() {
    if (!_storyGraph) return;
    try {
      _storyGraph.destroy();
    } catch {
      // The container may already have been replaced by route navigation.
    }
    _storyGraph = null;
  }

  function _mountStoryGraph(story) {
    const container = document.getElementById('import-story-graph');
    if (!container || !story?.flowNodes?.length) return;
    const cytoscapeFactory = globalThis.cytoscape;
    const fallback = container.parentElement?.querySelector('.import-story-graph-fallback');
    if (typeof cytoscapeFactory !== 'function') {
      container.hidden = true;
      if (fallback) fallback.hidden = false;
      return;
    }
    const style = getComputedStyle(container);
    const token = (name, fallbackValue) => style.getPropertyValue(name).trim() || fallbackValue;
    try {
      _storyGraph = cytoscapeFactory({
        container,
        elements: [
          ...story.flowNodes.map(node => ({ data: node })),
          ...story.flowEdges.map(edge => ({ data: edge })),
        ],
        style: [
          {
            selector: 'node',
            style: {
              width: 148,
              height: 48,
              shape: 'round-rectangle',
              label: 'data(graphLabel)',
              color: token('--text-cream', '#f0e6d2'),
              'font-family': token('--font-ui', 'sans-serif'),
              'font-size': 11,
              'text-wrap': 'wrap',
              'text-max-width': 130,
              'text-valign': 'center',
              'text-halign': 'center',
              'background-color': token('--bg-raised', '#241c0d'),
              'border-width': 2,
              'border-color': token('--text-muted', '#9a8660'),
            },
          },
          {
            selector: 'node[endpointKind = "section"]',
            style: {
              'border-style': 'dashed',
              'font-size': 10,
            },
          },
          {
            selector: 'node[kind = "thread"]',
            style: { 'border-color': token('--color-mystery', '#ce93d8') },
          },
          {
            selector: 'node[kind = "quest"]',
            style: { 'border-color': token('--accent-gold', '#c8a040') },
          },
          {
            selector: 'node[kind = "scenario"]',
            style: { 'border-color': token('--color-info', '#90caf9') },
          },
          {
            selector: 'node[kind = "encounter"]',
            style: { 'border-color': token('--color-danger-bright', '#ff8888') },
          },
          {
            selector: 'node[decision = true]',
            style: {
              shape: 'diamond',
              width: 118,
              height: 82,
              'border-color': token('--accent-gold', '#c8a040'),
              'background-color': token('--bg-deep', '#0e0a05'),
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1.5,
              'curve-style': 'bezier',
              'line-color': token('--text-muted', '#9a8660'),
              'target-arrow-color': token('--text-muted', '#9a8660'),
              'target-arrow-shape': 'triangle',
              label: 'data(label)',
              color: token('--text-light', '#d4c49a'),
              'font-family': token('--font-ui', 'sans-serif'),
              'font-size': 9,
              'text-wrap': 'wrap',
              'text-max-width': 112,
              'text-background-color': token('--bg-deep', '#0e0a05'),
              'text-background-opacity': 0.88,
              'text-background-padding': 3,
              'text-rotation': 'autorotate',
            },
          },
          {
            selector: 'edge[type = "branches"]',
            style: {
              width: 2.5,
              'line-color': token('--accent-gold', '#c8a040'),
              'target-arrow-color': token('--accent-gold', '#c8a040'),
              'line-style': 'dashed',
            },
          },
        ],
        layout: globalThis.cytoscapeDagre
          ? { name: 'dagre', rankDir: 'LR', nodeSep: 42, rankSep: 105, edgeSep: 18, padding: 36 }
          : { name: 'cose', animate: false, fit: true, padding: 36 },
        minZoom: 0.35,
        maxZoom: 2.2,
        autoungrabify: true,
        boxSelectionEnabled: false,
        userPanningEnabled: true,
        userZoomingEnabled: true,
      });
      _storyGraph.on('tap', 'node[scope = "planning"]', event => {
        const recordId = event.target.data('recordId');
        const card = [...document.querySelectorAll('.import-story-change')]
          .find(element => element.dataset.changeId.endsWith(`:planning_items:${recordId}`));
        if (card) card.open = true;
        card?.scrollIntoView({
          block: 'nearest',
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      });
    } catch (error) {
      console.warn('[import] story graph unavailable', error);
      _destroyStoryGraph();
      container.hidden = true;
      if (fallback) fallback.hidden = false;
    }
  }

  function _stopMapDrag() {
    if (!_dragCleanup) return;
    _dragCleanup();
    _dragCleanup = null;
  }

  function _pendingEditCount() {
    return _editedSourcePaths.size + _mapAdjustments.size;
  }

  function _updateReviewControls() {
    const placementCount = _mapAdjustments.size;
    const editCount = _pendingEditCount();
    const placementControls = document.getElementById('import-placement-controls');
    const placementMessage = document.getElementById('import-placement-count');
    if (placementControls) placementControls.hidden = placementCount === 0;
    if (placementMessage) {
      placementMessage.textContent = I18n.t('import.placementPending', { count: placementCount });
    }
    const editControls = document.getElementById('import-review-edit-controls');
    const editMessage = document.getElementById('import-review-edit-count');
    if (editControls) editControls.hidden = editCount === 0;
    if (editMessage) editMessage.textContent = I18n.t('import.editsPending', { count: editCount });
    const confirm = document.getElementById('import-confirm-plan');
    if (confirm) {
      confirm.checked = editCount ? false : _confirmed;
      confirm.disabled = !!editCount || !!_busy;
    }
    const commit = document.getElementById('import-commit-button');
    if (commit) {
      commit.disabled = !_preview?.committable || !_confirmed || !!_busy || !!editCount;
    }
  }

  function _setMapAdjustment(pin, x, y) {
    const sourceRef = pin.dataset.sourceRef;
    if (!sourceRef) return;
    const next = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
    _mapAdjustments.set(sourceRef, next);
    _confirmed = false;
    pin.dataset.mapX = String(next.x);
    pin.dataset.mapY = String(next.y);
    pin.style.setProperty('--import-pin-x', `${(next.x * 100).toFixed(4)}%`);
    pin.style.setProperty('--import-pin-y', `${(next.y * 100).toFixed(4)}%`);
    _updateReviewControls();
  }

  function _wireMapEditors() {
    for (const pin of document.querySelectorAll('.import-map-pin.is-adjustable')) {
      pin.addEventListener('keydown', event => {
        const direction = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[event.key];
        if (!direction) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.02 : 0.005;
        _setMapAdjustment(
          pin,
          Number(pin.dataset.mapX) + direction[0] * step,
          Number(pin.dataset.mapY) + direction[1] * step,
        );
      });
      pin.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const stage = pin.closest('.import-map-stage');
        const surface = stage?.querySelector(':scope > img');
        if (!surface) return;
        event.preventDefault();
        _stopMapDrag();
        pin.classList.add('is-dragging');
        const move = pointerEvent => {
          if (pointerEvent.pointerId !== event.pointerId) return;
          const rect = surface.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          _setMapAdjustment(
            pin,
            (pointerEvent.clientX - rect.left) / rect.width,
            (pointerEvent.clientY - rect.top) / rect.height,
          );
        };
        const finish = pointerEvent => {
          if (pointerEvent.pointerId !== event.pointerId) return;
          _stopMapDrag();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        _dragCleanup = () => {
          pin.classList.remove('is-dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
      });
    }
    _updateReviewControls();
  }

  function _wireChangeEditors() {
    for (const input of document.querySelectorAll('[data-import-source-path]')) {
      const update = () => {
        if (!_sourceDraft || _busy) return;
        let path;
        try {
          path = JSON.parse(input.dataset.importSourcePath || '[]');
        } catch {
          return;
        }
        let value;
        if (input.type === 'checkbox') {
          value = input.checked;
        } else if (input.dataset.importValueType === 'number') {
          value = input.value === '' ? null : Number(input.value);
        } else if (input.dataset.importValueType === 'null') {
          value = input.value === '' ? null : input.value;
        } else {
          value = input.value;
        }
        try {
          setValueAtPath(_sourceDraft, path, value);
        } catch {
          return;
        }
        _editedSourcePaths.add(JSON.stringify(path));
        _confirmed = false;
        input.closest('.import-form-field')?.classList.add('is-modified');
        _updateReviewControls();
      };
      input.addEventListener(input.matches('select, input[type="checkbox"], input[type="number"]')
        ? 'change'
        : 'input', update);
    }
    const blankValue = (value, key = '') => {
      if (key === 'id') return `new-${Date.now().toString(36)}`;
      if (typeof value === 'string') return '';
      if (typeof value === 'number') return 0;
      if (typeof value === 'boolean') return false;
      if (Array.isArray(value)) return [];
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
          .map(([field, entry]) => [field, blankValue(entry, field)]));
      }
      return null;
    };
    for (const button of document.querySelectorAll('[data-import-array-action]')) {
      button.addEventListener('click', () => {
        if (!_sourceDraft || _busy) return;
        let path;
        try {
          path = JSON.parse(button.dataset.importArrayPath || '[]');
        } catch {
          return;
        }
        const current = valueAtPath(_sourceDraft, path);
        if (!Array.isArray(current)) return;
        const next = [...current];
        if (button.dataset.importArrayAction === 'remove') {
          const index = Number(button.dataset.importArrayIndex);
          if (!Number.isInteger(index) || index < 0 || index >= next.length) return;
          next.splice(index, 1);
        } else {
          const field = String(path.at(-1) || '');
          if (field === 'sections') {
            next.push({
              id: `section-${Date.now().toString(36)}`,
              title: '',
              body: '',
            });
          } else {
            next.push(next.length ? blankValue(next.at(-1)) : '');
          }
        }
        setValueAtPath(_sourceDraft, path, next);
        _editedSourcePaths.add(JSON.stringify(path));
        _confirmed = false;
        const changeId = button.closest('.import-change')?.dataset.changeId || '';
        render();
        const change = [...document.querySelectorAll('.import-change')]
          .find(element => element.dataset.changeId === changeId);
        if (change) change.open = true;
      });
    }
  }

  function discardMapAdjustments() {
    if (_busy || !_mapAdjustments.size) return;
    _mapAdjustments.clear();
    _confirmed = false;
    render();
  }

  function discardReviewEdits() {
    if (_busy || !_pendingEditCount()) return;
    _sourceDraft = _sourceOriginal ? structuredClone(_sourceOriginal) : null;
    _editedSourcePaths.clear();
    _mapAdjustments.clear();
    _confirmed = false;
    render();
  }

  async function revalidateReviewEdits() {
    if (_busy || !_file || !_pendingEditCount()) return;
    const generation = ++_generation;
    const previousJobId = _jobId;
    let nextJobId = '';
    _busy = 'adjust';
    _error = null;
    render();
    try {
      const source = _sourceDraft
        ? structuredClone(_sourceDraft)
        : JSON.parse(await _file.text());
      const adjusted = _mapAdjustments.size
        ? applyLocationAdjustments(source, _mapAdjustments)
        : source;
      const nextFile = new File(
        [JSON.stringify(adjusted, null, 2)],
        _file.name || 'campaign-bundle.json',
        { type: 'application/json', lastModified: Date.now() },
      );
      const job = await _client.createJob({ providerId: PROVIDER_ID, file: nextFile });
      nextJobId = job.id;
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      const previewResult = await _client.preview(job.id);
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      _file = nextFile;
      _jobId = job.id;
      _preview = previewResult;
      _sourceOriginal = structuredClone(adjusted);
      _sourceDraft = structuredClone(adjusted);
      _sourceLocations.clear();
      _editedSourcePaths.clear();
      _mapAdjustments.clear();
      _confirmed = false;
      if (previousJobId) _client.cancel(previousJobId).catch(() => {});
      announce(I18n.t(_preview.committable ? 'import.previewReady' : 'import.previewBlocked'));
    } catch (error) {
      if (nextJobId) await _client.cancel(nextJobId).catch(() => {});
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.adjustFailed');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  function _reviewHtml() {
    const plan = _preview?.plan || {};
    const review = plan.review || {};
    const projection = review.playerProjection || {};
    const publicCount = Object.values(projection)
      .reduce((total, records) => total + (Array.isArray(records) ? records.length : 0), 0);
    const errorCount = (plan.diagnostics || []).filter(item => item.severity === 'error').length;
    return `
      <section class="import-ledger" aria-labelledby="import-review-title">
        <div class="import-ledger-head">
          <div>
            <p class="import-kicker">${esc(I18n.t('import.reviewKicker'))}</p>
            <h2 id="import-review-title">${esc(I18n.t('import.reviewTitle'))}</h2>
          </div>
          <span class="import-verdict ${_preview.committable ? 'is-ready' : 'is-blocked'}">
            ${esc(I18n.t(_preview.committable ? 'import.ready' : 'import.blocked'))}
          </span>
        </div>
        <div class="import-metrics">
          <div><strong>${Number(review.logicalRecordCount) || 0}</strong><span>${esc(I18n.t('import.records'))}</span></div>
          <div><strong>${Number(review.materializedWriteCount) || 0}</strong><span>${esc(I18n.t('import.writes'))}</span></div>
          <div><strong>${publicCount}</strong><span>${esc(I18n.t('import.playerVisible'))}</span></div>
          <div class="${errorCount ? 'is-danger' : ''}"><strong>${errorCount}</strong><span>${esc(I18n.t('import.errors'))}</span></div>
        </div>

        <section class="import-review-section">
          <h3>${esc(I18n.t('import.diagnostics'))}</h3>
          ${_diagnosticsHtml(plan.diagnostics)}
        </section>
        <section class="import-review-section import-story-section">
          <h3>${esc(I18n.t('import.flowPreview'))}</h3>
          <p class="import-section-copy">${esc(I18n.t('import.flowPreviewHint'))}</p>
          ${_storyPreviewHtml(review.changes)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.mapPreview'))}</h3>
          <p class="import-section-copy">${esc(I18n.t('import.mapPreviewHint'))}</p>
          <div class="import-placement-controls" id="import-placement-controls"
            aria-live="polite"${_mapAdjustments.size ? '' : ' hidden'}>
            <span id="import-placement-count">${esc(I18n.t('import.placementPending', {
              count: _mapAdjustments.size,
            }))}</span>
            <div>
              ${_button(
                _busy === 'adjust'
                  ? esc(I18n.t('import.applyingPlacements'))
                  : esc(I18n.t('import.applyPlacements')),
                'ImportCenter.revalidateReviewEdits',
                'edit-save-btn',
                !!_busy,
              )}
              ${_button(
                esc(I18n.t('import.discardPlacements')),
                'ImportCenter.discardMapAdjustments',
                'inline-create-btn',
                !!_busy,
              )}
            </div>
          </div>
          ${_mapPreviewHtml(review.changes)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.references'))}</h3>
          ${_referencesHtml(review.references)}
        </section>
        <section class="import-review-section">
          <h3>${esc(I18n.t('import.changes'))}</h3>
          <p class="import-section-copy">${esc(I18n.t('import.changesHint'))}</p>
          <div class="import-review-edit-controls" id="import-review-edit-controls"
            aria-live="polite"${_pendingEditCount() ? '' : ' hidden'}>
            <span id="import-review-edit-count">${esc(I18n.t('import.editsPending', {
              count: _pendingEditCount(),
            }))}</span>
            <div>
              ${_button(
                _busy === 'adjust'
                  ? esc(I18n.t('import.applyingEdits'))
                  : esc(I18n.t('import.revalidateEdits')),
                'ImportCenter.revalidateReviewEdits',
                'edit-save-btn',
                !!_busy,
              )}
              ${_button(
                esc(I18n.t('import.discardEdits')),
                'ImportCenter.discardReviewEdits',
                'inline-create-btn',
                !!_busy,
              )}
            </div>
          </div>
          ${_changesHtml(review.changes
            .filter(change => !change.collection.endsWith(':planning_items')))}
        </section>
        <div class="import-confirm">
          <label>
            <input type="checkbox" id="import-confirm-plan"${_confirmed ? ' checked' : ''}${_pendingEditCount() || _busy ? ' disabled' : ''}${dataOn('change', 'ImportCenter.setConfirmed', '$checked')}>
            <span>${esc(I18n.t('import.confirmExactPlan'))}</span>
          </label>
          <div class="import-actions">
            ${_button(esc(I18n.t('import.startOver')), 'ImportCenter.reset')}
            ${_button(
              `✓ ${esc(I18n.t('import.commit'))}`,
              'ImportCenter.commit',
              'edit-save-btn',
              !_preview.committable || !_confirmed || !!_busy || !!_pendingEditCount(),
              'import-commit-button',
            )}
          </div>
        </div>
      </section>`;
  }

  function _uploadHtml() {
    return `
      <section class="import-dropzone">
        <div class="import-drop-icon" aria-hidden="true">⌁</div>
        <div>
          <h2>${esc(I18n.t('import.chooseTitle'))}</h2>
          <p>${esc(I18n.t('import.chooseHint'))}</p>
        </div>
        <label class="inline-create-btn import-file-button">
          ${esc(I18n.t('import.chooseFile'))}
          <input type="file" accept=".json,application/json"${dataOn('change', 'ImportCenter.selectFile', '$el')}>
        </label>
        ${_file ? `
          <div class="import-file">
            <strong>${esc(_file.name || 'import.json')}</strong>
            <span>${esc(I18n.t('import.fileBytes', { count: _file.size }))}</span>
          </div>
          ${_button(
            _busy === 'preview' ? esc(I18n.t('import.reviewing')) : esc(I18n.t('import.preview')),
            'ImportCenter.preview',
            'edit-save-btn',
            !!_busy,
          )}` : ''}
      </section>`;
  }

  function _resultHtml() {
    return `
      <section class="import-complete" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <h2>${esc(I18n.t('import.completeTitle'))}</h2>
          <p>${esc(I18n.t('import.completeHint', {
            count: Number(_result?.operationCount) || 0,
          }))}</p>
          ${_result?.commitId ? `<code>${esc(_result.commitId)}</code>` : ''}
        </div>
        ${_button(esc(I18n.t('import.another')), 'ImportCenter.reset', 'edit-save-btn')}
      </section>`;
  }

  function render() {
    _stopMapDrag();
    _destroyStoryGraph();
    if (typeof window !== 'undefined') {
      const route = (window.location.hash || '#/').replace(/^#/, '') || '/';
      if (route !== '/import') return;
    }
    const main = _main();
    if (!main) return;
    if (!Role.isDM()) {
      main.innerHTML = `
        <div class="dm-panel">
          <h1>⌁ ${esc(I18n.t('import.title'))}</h1>
          <p class="dm-stub">${esc(I18n.t('import.dmOnly'))}</p>
        </div>`;
      return;
    }
    main.innerHTML = `
      <div class="import-center">
        <header class="page-header import-header">
          <div>
            <p class="import-kicker">${esc(I18n.t('import.kicker'))}</p>
            <h1>⌁ ${esc(I18n.t('import.title'))}</h1>
            <p class="subtitle">${esc(I18n.t('import.intro'))}</p>
          </div>
          <nav class="import-resources" aria-label="${esc(I18n.t('import.resources'))}">
            <a href="/api/content-import/schemas/campaign-bundle-v1" target="_blank" rel="noopener">${esc(I18n.t('import.schema'))}</a>
            <a href="/api/content-import/inventory?includeBodies=true" target="_blank" rel="noopener">${esc(I18n.t('import.inventory'))}</a>
          </nav>
        </header>
        ${_error ? `<div class="import-error" role="alert"><strong>${esc(I18n.t('import.error'))}</strong> ${esc(_error)}</div>` : ''}
        ${_result ? _resultHtml() : (_preview ? _reviewHtml() : _uploadHtml())}
      </div>`;
    if (_preview && !_result) {
      _wireMapEditors();
      _wireChangeEditors();
      _mountStoryGraph(_storyReview);
    }
  }

  function selectFile(input) {
    _file = input?.files?.[0] || null;
    _preview = null;
    _result = null;
    _error = null;
    _confirmed = false;
    _sourceOriginal = null;
    _sourceDraft = null;
    _sourceLocations.clear();
    _editedSourcePaths.clear();
    _mapAdjustments.clear();
    render();
  }

  async function preview() {
    if (!_file || _busy) return;
    const generation = ++_generation;
    _busy = 'preview';
    _error = null;
    render();
    try {
      const providers = await _client.listProviders();
      if (!providers.providers.some(provider => provider.id === PROVIDER_ID)) {
        throw new Error(I18n.t('import.providerUnavailable'));
      }
      const job = await _client.createJob({ providerId: PROVIDER_ID, file: _file });
      if (generation !== _generation) {
        await _client.cancel(job.id).catch(() => {});
        return;
      }
      _jobId = job.id;
      _preview = await _client.preview(job.id);
      if (generation !== _generation) return;
      _sourceOriginal = JSON.parse(await _file.text());
      _sourceDraft = structuredClone(_sourceOriginal);
      _sourceLocations.clear();
      _editedSourcePaths.clear();
      _mapAdjustments.clear();
      _confirmed = false;
      announce(I18n.t(_preview.committable ? 'import.previewReady' : 'import.previewBlocked'));
    } catch (error) {
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.error');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  function setConfirmed(value) {
    if (_pendingEditCount() || _busy) return;
    _confirmed = !!value;
    render();
  }

  async function commit() {
    if (!_jobId || !_preview?.previewToken || !_preview.committable
        || !_confirmed || _busy || _pendingEditCount()) return;
    const generation = _generation;
    _busy = 'commit';
    _error = null;
    render();
    try {
      _result = await _client.commit(_jobId, _preview.previewToken);
      await Store.load();
      if (generation === _generation) announce(I18n.t('import.completeTitle'));
    } catch (error) {
      if (generation === _generation) {
        _error = error?.message || I18n.t('import.error');
      }
    } finally {
      if (generation === _generation) {
        _busy = '';
        render();
      }
    }
  }

  async function reset() {
    _generation++;
    if (_jobId && !_result) {
      await _client.cancel(_jobId).catch(() => {});
    }
    _file = null;
    _preview = null;
    _result = null;
    _error = null;
    _busy = '';
    _confirmed = false;
    _jobId = '';
    _sourceOriginal = null;
    _sourceDraft = null;
    _sourceLocations.clear();
    _editedSourcePaths.clear();
    _mapAdjustments.clear();
    _storyReview = null;
    render();
  }

  function leave() {
    _generation++;
    _stopMapDrag();
    _destroyStoryGraph();
    const jobId = _jobId;
    const committing = _busy === 'commit';
    _file = null;
    _preview = null;
    _result = null;
    _error = null;
    _busy = '';
    _confirmed = false;
    _jobId = '';
    _sourceOriginal = null;
    _sourceDraft = null;
    _sourceLocations.clear();
    _editedSourcePaths.clear();
    _mapAdjustments.clear();
    _storyReview = null;
    if (jobId && !committing) _client.cancel(jobId).catch(() => {});
  }

  return Object.freeze({
    commit,
    discardMapAdjustments,
    discardReviewEdits,
    leave,
    preview,
    revalidateReviewEdits,
    render,
    reset,
    selectFile,
    setConfirmed,
  });
})();
