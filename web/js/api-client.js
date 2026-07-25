export const ApiClient = (() => {
  class ApiError extends Error {
    constructor(message, {
      status = 0,
      code = 'API_REQUEST_FAILED',
      details,
      body,
      cause,
    } = {}) {
      super(message, cause ? { cause } : undefined);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      if (details !== undefined) this.details = details;
      if (body !== undefined) this.body = body;
    }
  }

  function dispatchAuthFailure() {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('store:auth-failed'));
  }

  function create({
    fetchImpl,
    onAuthFailure = dispatchAuthFailure,
  } = {}) {
    if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }

    async function requestJson(url, {
      json,
      body,
      headers,
      credentials = 'same-origin',
      ...options
    } = {}) {
      if (json !== undefined && body !== undefined) {
        throw new TypeError('requestJson accepts either json or body, not both');
      }
      const requestHeaders = new Headers(headers || {});
      if (!requestHeaders.has('Accept')) requestHeaders.set('Accept', 'application/json');
      let requestBody = body;
      if (json !== undefined) {
        if (!requestHeaders.has('Content-Type')) {
          requestHeaders.set('Content-Type', 'application/json');
        }
        requestBody = JSON.stringify(json);
      }

      let response;
      try {
        const fetchRequest = fetchImpl || globalThis.fetch;
        if (typeof fetchRequest !== 'function') throw new TypeError('fetch is not available');
        response = await fetchRequest(url, {
          ...options,
          credentials,
          headers: requestHeaders,
          body: requestBody,
        });
      } catch (cause) {
        if (cause?.name === 'AbortError') throw cause;
        throw new ApiError('Network request failed', {
          code: 'API_NETWORK',
          cause,
        });
      }

      let responseBody = null;
      if (response.status !== 204) {
        if (typeof response.text === 'function') {
          const text = await response.text();
          if (text) {
            try {
              responseBody = JSON.parse(text);
            } catch (cause) {
              if (response.ok) {
                throw new ApiError('Server returned invalid JSON', {
                  status: response.status,
                  code: 'API_RESPONSE_INVALID',
                  cause,
                });
              }
            }
          }
        } else if (typeof response.json === 'function') {
          try {
            responseBody = await response.json();
          } catch (cause) {
            if (response.ok) {
              throw new ApiError('Server returned invalid JSON', {
                status: response.status,
                code: 'API_RESPONSE_INVALID',
                cause,
              });
            }
          }
        }
      }
      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && onAuthFailure) {
          onAuthFailure(response.status);
        }
        const structured = responseBody && typeof responseBody === 'object'
          ? responseBody
          : {};
        throw new ApiError(
          structured.error || `HTTP ${response.status}`,
          {
            status: response.status,
            code: structured.code || 'API_REQUEST_FAILED',
            details: structured.details,
            body: responseBody,
          },
        );
      }
      return responseBody;
    }

    return Object.freeze({
      requestJson,
      uploadJson(url, formData, options = {}) {
        return requestJson(url, { ...options, body: formData });
      },
    });
  }

  const defaultClient = create();
  return Object.freeze({
    ApiError,
    create,
    requestJson: defaultClient.requestJson,
    uploadJson: defaultClient.uploadJson,
  });
})();
