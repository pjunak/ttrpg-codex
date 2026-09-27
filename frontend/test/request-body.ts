/** JSON API mocks must verify the client actually sent a string body. */
export function requestBodyText(body: RequestInit["body"]): string {
  if (typeof body !== "string") throw new TypeError("Expected a serialized JSON request body");
  return body;
}
