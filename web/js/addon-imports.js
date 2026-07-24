function importError(code, message, status, details) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function assertText(value, label) {
  if (typeof value !== 'string' || !value) {
    throw importError('IMPORT_CLIENT_INVALID', `${label} is required`);
  }
  return value;
}

export function createAddonImportClient({
  addonId,
  enabled,
  isDM,
  fetchImpl = globalThis.fetch,
  FormDataImpl = globalThis.FormData,
  AbortControllerImpl = globalThis.AbortController,
} = {}) {
  const knownJobs = new Set();
  const active = new Map();
  let disposed = false;

  function ensureAvailable() {
    if (disposed) throw importError('IMPORT_CLIENT_DISPOSED', 'Import client is disposed');
    if (!enabled) throw importError('IMPORT_CAPABILITY_REQUIRED', 'Addon did not negotiate import providers');
    if (!isDM()) throw importError('IMPORT_FORBIDDEN', 'Import jobs require the effective DM role', 403);
  }

  function assertOwnedJob(jobId) {
    ensureAvailable();
    assertText(jobId, 'jobId');
    if (!knownJobs.has(jobId)) {
      throw importError('IMPORT_JOB_NOT_FOUND', 'Import job is unavailable', 404);
    }
  }

  async function request(path, options = {}, jobId = '') {
    ensureAvailable();
    const controller = new AbortControllerImpl();
    const group = active.get(jobId) || new Set();
    group.add(controller);
    active.set(jobId, group);
    try {
      const response = await fetchImpl(path, {
        credentials: 'same-origin',
        ...options,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw importError(
          body.code || 'IMPORT_REQUEST_FAILED',
          body.error || `Import request failed (${response.status})`,
          response.status,
          body.details,
        );
      }
      return body;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') {
        throw importError('IMPORT_CANCELLED', 'Import request was cancelled', 409);
      }
      throw importError('IMPORT_NETWORK', 'Import request failed before a response was received');
    } finally {
      group.delete(controller);
      if (!group.size && active.get(jobId) === group) active.delete(jobId);
    }
  }

  function abortJobRequests(jobId) {
    const group = active.get(jobId);
    if (!group) return;
    for (const controller of group) controller.abort();
    active.delete(jobId);
  }

  return Object.freeze({
    async listProviders() {
      const body = await request('/api/content-import/providers');
      return {
        version: body.version,
        limits: body.limits || {},
        providers: (body.providers || []).filter(provider => provider.addonId === addonId),
      };
    },

    async createJob({ providerId, file, format = 'json' } = {}) {
      ensureAvailable();
      assertText(providerId, 'providerId');
      if (!file || typeof file !== 'object' || typeof file.size !== 'number') {
        throw importError('IMPORT_INPUT_INVALID', 'Import file is required');
      }
      const form = new FormDataImpl();
      form.append('addonId', addonId);
      form.append('providerId', providerId);
      form.append('format', format);
      form.append('input', file, typeof file.name === 'string' ? file.name : 'import.json');
      const body = await request('/api/content-import/jobs', {
        method: 'POST',
        body: form,
      });
      const job = body.job;
      if (!job || typeof job.id !== 'string') {
        throw importError('IMPORT_RESPONSE_INVALID', 'Import job response is invalid');
      }
      knownJobs.add(job.id);
      return job;
    },

    async preview(jobId) {
      assertOwnedJob(jobId);
      return request(`/api/content-import/jobs/${encodeURIComponent(jobId)}/preview`, {
        method: 'POST',
      }, jobId);
    },

    async getJob(jobId) {
      assertOwnedJob(jobId);
      const body = await request(`/api/content-import/jobs/${encodeURIComponent(jobId)}`, {}, jobId);
      return body.job;
    },

    async commit(jobId, previewToken) {
      assertOwnedJob(jobId);
      assertText(previewToken, 'previewToken');
      return request(`/api/content-import/jobs/${encodeURIComponent(jobId)}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewToken }),
      }, jobId);
    },

    async cancel(jobId) {
      assertOwnedJob(jobId);
      abortJobRequests(jobId);
      const body = await request(`/api/content-import/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
      }, jobId);
      return body.job;
    },

    async dispose() {
      if (disposed) return;
      for (const group of active.values()) {
        for (const controller of group) controller.abort();
      }
      active.clear();
      disposed = true;
      knownJobs.clear();
    },
  });
}
